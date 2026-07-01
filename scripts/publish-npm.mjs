#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const packages = ["@iflytekopensource/adapters", "@iflytekopensource/hermes"];

const extraArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const hasDistTag = extraArgs.some((arg) => arg === "--tag" || arg.startsWith("--tag="));
const publishArgs = hasDistTag ? extraArgs : ["--tag", "latest", ...extraArgs];

for (const packageName of packages) {
  const result = spawnSync(
    "pnpm",
    ["--filter", packageName, "publish", "--access", "public", "--no-git-checks", ...publishArgs],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
