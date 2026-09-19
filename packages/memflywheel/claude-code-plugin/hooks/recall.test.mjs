import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRecallOutput,
  ensureRuntimeDependencies,
  loadMemFlywheel,
  parseHookInput,
  resolveMemFlywheelRoot,
  runHook,
} from "./recall.mjs";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(hooksDir);
const packageRoot = path.dirname(pluginRoot);
const repoRoot = path.resolve(packageRoot, "..", "..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeScribe(context) {
  const calls = [];
  return {
    calls,
    async onSessionStart(input) {
      calls.push(["onSessionStart", input]);
    },
    async onPromptBuild(input) {
      calls.push(["onPromptBuild", input]);
      return context;
    },
  };
}

const CONTEXT = {
  enabled: true,
  systemPrompt: "stable memory rules",
  preludePrompt: "<system-reminder>MEMORY.md cues</system-reminder>",
  skillPreludePrompt: "learned skill routes",
};

test("resolveMemFlywheelRoot prefers MEMFLYWHEEL_HOME, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
  assert.equal(
    resolveMemFlywheelRoot({ MEMFLYWHEEL_HOME: " /mem ", CLAUDE_CONFIG_DIR: "/cfg" }),
    "/mem",
  );
  assert.equal(
    resolveMemFlywheelRoot({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/u" }),
    path.join("/cfg", "memflywheel"),
  );
  assert.equal(
    resolveMemFlywheelRoot({ HOME: "/home/u" }),
    path.join("/home/u", ".claude", "memflywheel"),
  );
  assert.equal(
    resolveMemFlywheelRoot({ USERPROFILE: "C:\\Users\\u" }),
    path.join("C:\\Users\\u", ".claude", "memflywheel"),
  );
});

test("parseHookInput reads Claude Code hook fields and rejects non-objects", () => {
  assert.deepEqual(
    parseHookInput(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" }),
    ),
    { event: "UserPromptSubmit", sessionId: "s1", prompt: "hi" },
  );
  assert.deepEqual(parseHookInput(""), { event: "", sessionId: "", prompt: "" });
  assert.throws(() => parseHookInput("[]"), /not a JSON object/);
  assert.throws(() => parseHookInput("{"));
});

test("SessionStart starts the session and injects only the stable rules", async () => {
  const scribe = fakeScribe(CONTEXT);
  const out = await buildRecallOutput(
    { event: "SessionStart", sessionId: "s1", prompt: "" },
    scribe,
  );
  assert.deepEqual(scribe.calls, [
    ["onSessionStart", { sessionId: "s1" }],
    ["onPromptBuild", { sessionId: "s1" }],
  ]);
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "stable memory rules" },
  });
});

test("UserPromptSubmit passes the prompt as the recall query and injects cues", async () => {
  const scribe = fakeScribe(CONTEXT);
  const out = await buildRecallOutput(
    { event: "UserPromptSubmit", sessionId: "s1", prompt: "deploy steps?" },
    scribe,
  );
  assert.deepEqual(scribe.calls, [["onPromptBuild", { sessionId: "s1", query: "deploy steps?" }]]);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(
    out.hookSpecificOutput.additionalContext,
    `${CONTEXT.preludePrompt}\n\n${CONTEXT.skillPreludePrompt}`,
  );
});

test("recall injects nothing when disabled, empty, unmapped, or without a session", async () => {
  const disabled = fakeScribe({ ...CONTEXT, enabled: false });
  assert.equal(
    await buildRecallOutput({ event: "UserPromptSubmit", sessionId: "s", prompt: "" }, disabled),
    undefined,
  );

  const empty = fakeScribe({ enabled: true, systemPrompt: "", preludePrompt: "  " });
  assert.equal(
    await buildRecallOutput({ event: "UserPromptSubmit", sessionId: "s", prompt: "" }, empty),
    undefined,
  );

  // Write-side events are not wired in the recall-only integration.
  const unmapped = fakeScribe(CONTEXT);
  for (const event of ["Stop", "SessionEnd", "PostToolUse"]) {
    assert.equal(
      await buildRecallOutput({ event, sessionId: "s", prompt: "" }, unmapped),
      undefined,
    );
  }
  assert.equal(
    await buildRecallOutput({ event: "SessionStart", sessionId: "", prompt: "" }, unmapped),
    undefined,
  );
  assert.deepEqual(unmapped.calls, []);
});

test("ensureRuntimeDependencies installs once per plugin package.json and retries after failure", (t) => {
  const dir = tempDir(t, "memflywheel-cc-deps-");
  const root = path.join(dir, "plugin");
  const dataDir = path.join(dir, "data");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"dependencies":{"x":"1.0.0"}}\n');

  const spawned = [];
  const installing = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const pkgDir = path.join(opts.cwd, "node_modules", "@iflytekopensource", "memflywheel");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), "{}");
    return { status: 0 };
  };

  assert.equal(ensureRuntimeDependencies({ pluginRoot: root, dataDir, spawn: installing }), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "npm");
  assert.equal(spawned[0].args[0], "install");
  assert.deepEqual(spawned[0].opts.stdio, ["ignore", 2, 2], "npm must not write to hook stdout");
  assert.equal(spawned[0].opts.shell, process.platform === "win32");

  // Unchanged manifest + installed package: no reinstall.
  assert.equal(ensureRuntimeDependencies({ pluginRoot: root, dataDir, spawn: installing }), false);
  assert.equal(spawned.length, 1);

  // Plugin update changes package.json: install again, and a failure drops the
  // copied manifest so the next session retries.
  writeFileSync(path.join(root, "package.json"), '{"dependencies":{"x":"2.0.0"}}\n');
  assert.throws(
    () => ensureRuntimeDependencies({ pluginRoot: root, dataDir, spawn: () => ({ status: 1 }) }),
    /npm install .* failed \(exit code 1\)/,
  );
  assert.equal(existsSync(path.join(dataDir, "package.json")), false);
  assert.equal(ensureRuntimeDependencies({ pluginRoot: root, dataDir, spawn: installing }), true);
});

test("loadMemFlywheel resolves the installed package's ESM entry", async (t) => {
  const dataDir = tempDir(t, "memflywheel-cc-load-");
  await assert.rejects(loadMemFlywheel({ dataDir, env: {} }), /not installed yet/);

  const pkgDir = path.join(dataDir, "node_modules", "@iflytekopensource", "memflywheel");
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ type: "module", exports: { ".": { import: "./dist/index.js" } } }),
  );
  writeFileSync(path.join(pkgDir, "dist", "index.js"), "export const marker = 'installed';\n");
  assert.equal((await loadMemFlywheel({ dataDir, env: {} })).marker, "installed");
  await assert.rejects(loadMemFlywheel({ dataDir: "", env: {} }), /CLAUDE_PLUGIN_DATA is not set/);
});

test("runHook drives the real recall-only runtime from the built package", async (t) => {
  const dir = tempDir(t, "memflywheel-cc-run-");
  const env = {
    MEMFLYWHEEL_MODULE: path.join(packageRoot, "dist", "index.js"),
    MEMFLYWHEEL_HOME: path.join(dir, "memflywheel"),
  };

  const start = await runHook(
    JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", source: "startup" }),
    { env, pluginRoot },
  );
  assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(start.hookSpecificOutput.additionalContext.length > 0);

  const turn = await runHook(
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hello" }),
    { env, pluginRoot },
  );
  if (turn) assert.equal(turn.hookSpecificOutput.hookEventName, "UserPromptSubmit");

  assert.equal(
    await runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), {
      env,
      pluginRoot,
    }),
    undefined,
  );
});

test("plugin manifests stay aligned with the package and marketplace", () => {
  const pkg = readJson(path.join(packageRoot, "package.json"));
  const plugin = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  const runtime = readJson(path.join(pluginRoot, "package.json"));
  const marketplace = readJson(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
  const hooks = readJson(path.join(pluginRoot, "hooks", "hooks.json"));

  // The runtime dependency must be a published release of this package.
  assert.equal(plugin.version, pkg.version);
  assert.equal(runtime.version, pkg.version);
  assert.equal(runtime.dependencies[pkg.name], pkg.version);

  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, "marketplace lists the plugin");
  assert.equal(path.resolve(repoRoot, entry.source), pluginRoot);

  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const groups of Object.values(hooks.hooks)) {
    for (const hook of groups.flatMap((group) => group.hooks)) {
      assert.equal(hook.type, "command");
      assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/memflywheel-hook\.mjs/);
    }
  }
  assert.ok(existsSync(path.join(hooksDir, "memflywheel-hook.mjs")));
});
