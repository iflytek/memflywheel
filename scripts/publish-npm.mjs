#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GHP_REGISTRY = "https://npm.pkg.github.com";
const SCOPE_FROM = "@iflytekopensource/";
const SCOPE_TO = "@iflytek/";
const TARGET_PACKAGES = ["@iflytekopensource/adapters", "@iflytekopensource/hermes"];

function rewriteScope(value) {
  return value.split(SCOPE_FROM).join(SCOPE_TO);
}

function parseArgs() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  let registry;
  const publishArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--registry" && args[i + 1]) {
      registry = args[++i];
    } else if (args[i].startsWith("--registry=")) {
      registry = args[i].slice("--registry=".length);
    } else {
      publishArgs.push(args[i]);
    }
  }
  if (!publishArgs.some((a) => a === "--tag" || a.startsWith("--tag="))) {
    publishArgs.unshift("--tag", "latest");
  }
  return { registry, publishArgs };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) {
    console.error(`Failed to run ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function publishToNpm(publishArgs) {
  for (const pkg of TARGET_PACKAGES) {
    run("pnpm", ["--filter", pkg, "publish", "--no-git-checks", "--access", "public", ...publishArgs]);
  }
}

function publishToGitHubPackages(publishArgs) {
  const staging = mkdtempSync(join(tmpdir(), "ghpkg-"));
  try {
    for (const pkg of TARGET_PACKAGES) {
      run("pnpm", ["--filter", pkg, "pack", "--pack-destination", staging]);
    }

    for (const tarball of readdirSync(staging).filter((f) => f.endsWith(".tgz"))) {
      const dir = join(staging, tarball.replace(".tgz", ""));
      mkdirSync(dir, { recursive: true });
      run("tar", ["xzf", join(staging, tarball), "-C", dir, "package"]);

      const pkgDir = join(dir, "package");
      const pjPath = join(pkgDir, "package.json");
      const pj = JSON.parse(readFileSync(pjPath, "utf8"));

      // Rewrite package name and dependency keys
      pj.name = rewriteScope(pj.name);
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        if (!pj[field]) continue;
        for (const [k, v] of Object.entries(pj[field])) {
          if (k.startsWith(SCOPE_FROM)) {
            delete pj[field][k];
            pj[field][rewriteScope(k)] = v;
          }
        }
      }
      writeFileSync(pjPath, JSON.stringify(pj, null, 2) + "\n");

      // Rewrite runtime imports in hermes package
      if (pj.name === `${SCOPE_TO}hermes`) {
        for (const rel of ["bin/install.mjs", "bridge/worker.mjs", "provider/__init__.py"]) {
          try {
            const fp = join(pkgDir, rel);
            const orig = readFileSync(fp, "utf8");
            const rewritten = rewriteScope(orig);
            if (orig !== rewritten) writeFileSync(fp, rewritten);
          } catch (err) {
            if (err.code !== "ENOENT") console.warn(`Warning: failed to rewrite ${rel}: ${err.message}`);
          }
        }
      }

      run("npm", [
        "publish", "./package",
        "--registry", GHP_REGISTRY,
        "--access", "public",
        ...publishArgs,
      ]);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const { registry, publishArgs } = parseArgs();
if (registry === GHP_REGISTRY) {
  publishToGitHubPackages(publishArgs);
} else {
  publishToNpm(publishArgs);
scripts/publish-npm.mjs}
