/**
 * MemFlywheel recall for Claude Code hooks.
 *
 *  - SessionStart     → onSessionStart + onPromptBuild: stable memory rules
 *  - UserPromptSubmit → onPromptBuild(query): query-aware MEMORY.md cues and
 *                       learned-skill routes
 *
 * Both are returned as Claude Code `hookSpecificOutput.additionalContext`.
 *
 * This is a recall-only integration. Stop / SessionEnd extraction, dream, and
 * skill evolution are intentionally not wired: they need a structured
 * host-model binding that Claude Code hooks do not expose, and MemFlywheel does
 * not parse free-form model text or fall back to a hidden provider.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@iflytekopensource/memflywheel";

/** Claude Code hook events this integration answers; everything else is a no-op. */
export const RECALL_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

/**
 * Memory root. `MEMFLYWHEEL_HOME` wins; otherwise a Claude-owned directory
 * (`$CLAUDE_CONFIG_DIR/memflywheel`, default `~/.claude/memflywheel`). The root
 * deliberately lives outside `${CLAUDE_PLUGIN_DATA}`, which
 * `claude plugin uninstall` deletes unless `--keep-data` is passed.
 */
export function resolveMemFlywheelRoot(env = process.env) {
  const explicit = env.MEMFLYWHEEL_HOME?.trim();
  if (explicit) return explicit;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return path.join(configDir, "memflywheel");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return path.join(home, ".claude", "memflywheel");
}

/** Parse the JSON object Claude Code writes to a command hook's stdin. */
export function parseHookInput(raw) {
  const parsed = JSON.parse(raw && raw.trim() ? raw : "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook input is not a JSON object");
  }
  const read = (key) => (typeof parsed[key] === "string" ? parsed[key] : "");
  return {
    event: read("hook_event_name"),
    sessionId: read("session_id"),
    prompt: read("prompt"),
  };
}

function joinSegments(...segments) {
  return segments
    .filter((segment) => typeof segment === "string" && segment.trim() !== "")
    .join("\n\n");
}

/**
 * Map one hook event onto the scribe and build the hook's stdout payload.
 * Returns `undefined` when there is nothing to inject.
 *
 * SessionStart carries only the stable rules: the dynamic index prelude is
 * injected by UserPromptSubmit on every turn, so repeating it at session start
 * would duplicate it in the first turn's context.
 */
export async function buildRecallOutput(input, scribe) {
  if (!RECALL_EVENTS.has(input.event) || !input.sessionId) return undefined;
  const { sessionId } = input;

  let additionalContext;
  if (input.event === "SessionStart") {
    await scribe.onSessionStart({ sessionId });
    const context = await scribe.onPromptBuild({ sessionId });
    if (!context.enabled) return undefined;
    additionalContext = joinSegments(context.systemPrompt);
  } else {
    const context = await scribe.onPromptBuild({ sessionId, query: input.prompt || undefined });
    if (!context.enabled) return undefined;
    additionalContext = joinSegments(context.preludePrompt, context.skillPreludePrompt);
  }

  if (!additionalContext) return undefined;
  return { hookSpecificOutput: { hookEventName: input.event, additionalContext } };
}

function installedPackageDir(dataDir) {
  return path.join(dataDir, "node_modules", ...PACKAGE_NAME.split("/"));
}

/**
 * Install the plugin's pinned runtime dependencies into `${CLAUDE_PLUGIN_DATA}`
 * when the plugin's package.json changed (first run or plugin update). Marketplace
 * installs copy only the plugin directory, so the npm package cannot be reached
 * from the repository checkout. Returns true when an install ran.
 */
export function ensureRuntimeDependencies({
  pluginRoot,
  dataDir,
  spawn = spawnSync,
  platform = process.platform,
}) {
  const source = path.join(pluginRoot, "package.json");
  const target = path.join(dataDir, "package.json");
  const installedManifest = path.join(installedPackageDir(dataDir), "package.json");
  if (
    existsSync(target) &&
    existsSync(installedManifest) &&
    readFileSync(source, "utf8") === readFileSync(target, "utf8")
  ) {
    return false;
  }

  mkdirSync(dataDir, { recursive: true });
  copyFileSync(source, target);
  // stdout belongs to the hook protocol; route npm output to stderr.
  const result = spawn("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: dataDir,
    stdio: ["ignore", 2, 2],
    shell: platform === "win32",
  });
  if (result.error || result.status !== 0) {
    // Drop the copied manifest so the next SessionStart retries the install.
    rmSync(target, { force: true });
    const reason = result.error ? result.error.message : `exit code ${result.status}`;
    throw new Error(`npm install of ${PACKAGE_NAME} failed (${reason})`);
  }
  return true;
}

/**
 * Import the MemFlywheel package. `MEMFLYWHEEL_MODULE` points at a local entry
 * file (for example a workspace `dist/index.js`) and skips the plugin-data
 * install; otherwise the package installed in `${CLAUDE_PLUGIN_DATA}` is used.
 */
export async function loadMemFlywheel({ dataDir, env = process.env }) {
  const override = env.MEMFLYWHEEL_MODULE?.trim();
  if (override) return import(pathToFileURL(path.resolve(override)).href);
  if (!dataDir) throw new Error("CLAUDE_PLUGIN_DATA is not set");

  const packageDir = installedPackageDir(dataDir);
  const manifestPath = path.join(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${PACKAGE_NAME} is not installed yet; start a new Claude Code session`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.exports?.["."]?.import ?? manifest.main;
  if (typeof entry !== "string") throw new Error(`${PACKAGE_NAME} has no ESM entry point`);
  return import(pathToFileURL(path.join(packageDir, entry)).href);
}

/** Run one hook invocation end to end. Resolves to the stdout payload, if any. */
export async function runHook(raw, { env = process.env, pluginRoot } = {}) {
  const input = parseHookInput(raw);
  if (!RECALL_EVENTS.has(input.event)) return undefined;

  const dataDir = env.CLAUDE_PLUGIN_DATA?.trim();
  if (!env.MEMFLYWHEEL_MODULE?.trim() && input.event === "SessionStart") {
    if (!dataDir) throw new Error("CLAUDE_PLUGIN_DATA is not set");
    ensureRuntimeDependencies({ pluginRoot, dataDir });
  }

  const memflywheel = await loadMemFlywheel({ dataDir, env });
  const { scribe } = memflywheel.createMemFlywheelHarnessRuntime({
    mode: "recall-only",
    root: resolveMemFlywheelRoot(env),
  });
  return buildRecallOutput(input, scribe);
}
