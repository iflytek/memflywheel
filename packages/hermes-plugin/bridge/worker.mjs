#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const adapters = await import(
  process.env.MEMFLYWHEEL_ADAPTERS_IMPORT || "@iflytekopensource/adapters"
);
const { createMemFlywheelHarnessRuntime, normalizeMessages } = adapters;

let runtime;
let runtimeKey = "";
let nextModelId = 1;
const pendingModels = new Map();

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function createJsonCursorStore(root) {
  const file = join(root, ".memflywheel", "hermes-cursors.json");
  function read() {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  }
  return {
    get(sessionId) {
      const value = read()[sessionId];
      return Number.isInteger(value) ? value : null;
    },
    set(sessionId, cursorIndex) {
      mkdirSync(dirname(file), { recursive: true });
      const cursors = read();
      cursors[sessionId] = cursorIndex;
      writeFileSync(file, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

async function complete(request) {
  const id = `model-${nextModelId++}`;
  emit({ type: "model_request", id, request });
  return await new Promise((resolve, reject) => {
    pendingModels.set(id, { resolve, reject });
  });
}

function ensureRuntime(options = {}) {
  const root = options.root || process.env.MEMFLYWHEEL_HOME;
  const key = JSON.stringify({
    root,
    refuseSecrets: options.refuseSecrets === true,
    learnedSkills: options.learnedSkills === true,
  });
  if (runtime && runtimeKey === key) return runtime;
  runtime?.dispose?.();
  const learnedSkills =
    options.learnedSkills === true && root
      ? { skillsRoot: join(root, "learned-skills") }
      : undefined;
  runtime = createMemFlywheelHarnessRuntime({
    root,
    model: { complete },
    cursorStore: root ? createJsonCursorStore(root) : undefined,
    refuseSecrets: options.refuseSecrets === true,
    learnedSkills,
  });
  runtimeKey = key;
  return runtime;
}

function turnMessages(payload) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    return normalizeMessages(payload.messages);
  }
  return normalizeMessages([
    { role: "user", text: payload.userContent || "" },
    { role: "assistant", text: payload.assistantContent || "" },
  ]);
}

function joinedContext(ctx) {
  return [ctx.systemPrompt, ctx.preludePrompt]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n\n");
}

function syncLearnedSkillsToHermes(payload) {
  if (payload.learnedSkills !== true || !payload.root) return;
  const sourceRoot = join(payload.root, "learned-skills");
  if (!existsSync(sourceRoot)) return;
  const hermesHome = payload.hermesHome || process.env.HERMES_HOME || join(homedir(), ".hermes");
  const targetRoot = join(hermesHome, "skills", "memflywheel");
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("memflywheel-learned-")) continue;
    const sourceDir = join(sourceRoot, entry.name);
    if (!existsSync(join(sourceDir, "SKILL.md"))) continue;
    const targetDir = join(targetRoot, entry.name);
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
  }
}

async function withSkillSync(payload, fn) {
  try {
    return await fn();
  } finally {
    syncLearnedSkillsToHermes(payload);
  }
}

async function runCommand(command, payload = {}) {
  const rt = ensureRuntime(payload);
  const sessionId = payload.sessionId || "default";
  if (command === "initialize") {
    return withSkillSync(payload, async () => {
      await rt.scribe.onSessionStart({ sessionId });
      return { root: rt.sdk.root, mode: rt.mode };
    });
  }
  if (command === "prompt_build") {
    return withSkillSync(payload, async () => {
      const ctx = await rt.scribe.onPromptBuild({ sessionId, query: payload.query || "" });
      return { ...ctx, context: joinedContext(ctx) };
    });
  }
  if (command === "turn_end") {
    return withSkillSync(payload, () =>
      rt.scribe.onTurnEnd({ sessionId, messages: turnMessages(payload) }),
    );
  }
  if (command === "session_end") {
    return withSkillSync(payload, async () => {
      await rt.scribe.onSessionEnd({ sessionId });
      return rt.sdk.onIdle({ force: payload.force === true });
    });
  }
  if (command === "idle") {
    return withSkillSync(payload, () => rt.sdk.onIdle({ force: payload.force === true }));
  }
  if (command === "save") {
    return await rt.sdk.save(payload.memory);
  }
  throw new Error(`unknown command: ${command}`);
}

async function handleCommand(message) {
  try {
    const result = await runCommand(message.command, message.payload || {});
    emit({ type: "command_response", id: message.id, result });
  } catch (error) {
    emit({
      type: "command_response",
      id: message.id,
      error: { message: error?.message || String(error), stack: error?.stack || "" },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    emit({ type: "protocol_error", error: { message: error?.message || String(error) } });
    return;
  }
  if (message.type === "model_response") {
    const pending = pendingModels.get(message.id);
    if (!pending) return;
    pendingModels.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || String(message.error)));
    else pending.resolve(message.result);
    return;
  }
  if (message.type === "command") void handleCommand(message);
});
