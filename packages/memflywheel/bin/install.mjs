#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: memflywheel-hermes-install

Installs the MemFlywheel Hermes MemoryProvider plugin into:
  $HERMES_HOME/plugins/memflywheel

Installs and enables the companion host-write guard in:
  $HERMES_HOME/plugins/memflywheel-guard

If HERMES_HOME is unset, the installer uses ~/.hermes.`);
  process.exit(0);
}

const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");
const target = join(hermesHome, "plugins", "memflywheel");
const guardTarget = join(hermesHome, "plugins", "memflywheel-guard");
const packageImport = new URL("../dist/index.js", import.meta.url).href;

function disableHermesNativeMemoryTool(configPath) {
  if (!existsSync(configPath)) return false;
  const text = readFileSync(configPath, "utf8");
  if (/^agent:\n(?:  .*\n)*?  disabled_toolsets:\n(?:    - .*\n)*    - memory\n/m.test(text))
    return false;
  let next = text.replace(/^agent:\n(?:  .*\n)*?  disabled_toolsets: \[\]\n/m, (block) =>
    block.replace("  disabled_toolsets: []\n", "  disabled_toolsets:\n    - memory\n"),
  );
  if (next === text) {
    next = text.replace(
      /^agent:\n(?:  .*\n)*?  disabled_toolsets:\n((?:    - .*\n)*)/m,
      (block, items) => block.replace(items, `${items}    - memory\n`),
    );
  }
  if (next === text) {
    throw new Error(
      `Cannot update ${configPath}: expected agent.disabled_toolsets in Hermes config`,
    );
  }
  writeFileSync(configPath, next, { mode: 0o600 });
  return true;
}

function nativeMemoryBackupPath(disabledDir) {
  const targetPath = join(disabledDir, "MEMORY.md");
  if (!existsSync(targetPath)) return targetPath;
  return join(disabledDir, `MEMORY.${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
}

const nativeMemory = join(hermesHome, "memories", "MEMORY.md");
if (existsSync(nativeMemory)) {
  const disabledDir = join(hermesHome, "memories.disabled-by-memflywheel");
  mkdirSync(disabledDir, { recursive: true });
  const backupPath = nativeMemoryBackupPath(disabledDir);
  renameSync(nativeMemory, backupPath);
  console.log(`Moved Hermes native memory to ${backupPath}`);
}
rmSync(join(hermesHome, "memories", "MEMORY.md.lock"), { force: true });
if (disableHermesNativeMemoryTool(join(hermesHome, "config.yaml"))) {
  console.log("Disabled Hermes native memory toolset in config.yaml");
}

mkdirSync(target, { recursive: true });
copyFileSync(join(root, "provider", "__init__.py"), join(target, "__init__.py"));
copyFileSync(join(root, "bridge", "worker.mjs"), join(target, "worker.mjs"));
copyFileSync(join(root, "plugin.yaml"), join(target, "plugin.yaml"));
writeFileSync(join(target, "install.json"), `${JSON.stringify({ packageImport }, null, 2)}\n`, {
  mode: 0o600,
});

mkdirSync(guardTarget, { recursive: true });
copyFileSync(join(root, "guard", "__init__.py"), join(guardTarget, "__init__.py"));
copyFileSync(join(root, "guard", "plugin.yaml"), join(guardTarget, "plugin.yaml"));

const enabled = spawnSync(
  "hermes",
  ["plugins", "enable", "memflywheel-guard", "--allow-tool-override"],
  { env: { ...process.env, HERMES_HOME: hermesHome }, encoding: "utf8" },
);
if (enabled.status !== 0) {
  throw new Error(enabled.stderr || enabled.stdout || "Failed to enable memflywheel-guard");
}

console.log(`Installed MemFlywheel Hermes provider to ${target}`);
console.log(`Installed MemFlywheel host write guard to ${guardTarget}`);
console.log("Activate with: hermes config set memory.provider memflywheel");
