#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = ["@iflytekopensource/adapters", "@iflytekopensource/hermes"];

function parseArgs() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
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

  const hasDistTag = publishArgs.some((a) => a === "--tag" || a.startsWith("--tag="));
  if (!hasDistTag) publishArgs.unshift("--tag", "latest");

  return { registry, publishArgs };
}

function buildArgs({ publishArgs, registry, access }) {
  const args = ["publish", "--no-git-checks", ...publishArgs];
  if (registry) args.push("--registry", registry);
  if (access) args.push("--access", access);
  return args;
}

async function publishToGitHubPackages({ publishArgs }) {
  const staging = mkdtempSync(join(tmpdir(), "ghpkg-"));

  try {
    for (const pkg of packages) {
      const pack = spawnSync("pnpm", ["--filter", pkg, "pack", "--pack-destination", staging], {
        stdio: "inherit",
      });
      if (pack.status !== 0) process.exit(pack.status ?? 1);
    }

    for (const tarball of spawnSync("ls", [staging], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter(Boolean)) {
      const dir = join(staging, tarball.replace(".tgz", ""));
      mkdirSync(dir);
      spawnSync("tar", ["xzf", join(staging, tarball), "-C", dir, "package"], { stdio: "inherit" });

      const pjPath = join(dir, "package", "package.json");
      const pj = JSON.parse(readFileSync(pjPath, "utf8"));
      pj.name = pj.name.replace("@iflytekopensource/", "@iflytek/");
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        if (pj[field]) {
          for (const [k, v] of Object.entries(pj[field])) {
            if (k.startsWith("@iflytekopensource/")) {
              delete pj[field][k];
              pj[field][k.replace("@iflytekopensource/", "@iflytek/")] = v;
            }
          }
        }
      }
      writeFileSync(pjPath, JSON.stringify(pj, null, 2) + "\n");

      const result = spawnSync(
        "npm",
        ["publish", "./package", "--registry", "https://npm.pkg.github.com", "--access", "public"],
        { stdio: "inherit", env: { ...process.env, NODE_AUTH_TOKEN: process.env.GITHUB_TOKEN } },
      );
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function publishToNpm({ publishArgs }) {
  const args = buildArgs({ publishArgs, access: "public" });
  for (const pkg of packages) {
    const result = spawnSync("pnpm", ["--filter", pkg, ...args], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const { registry, publishArgs } = parseArgs();

if (registry === "https://npm.pkg.github.com") {
  await publishToGitHubPackages({ publishArgs });
} else {
  publishToNpm({ publishArgs });
}
