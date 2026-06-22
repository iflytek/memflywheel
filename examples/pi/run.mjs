/**
 * Runnable Pi example / smoke test.
 *
 * Drives a mock Pi host through the four lifecycle events the `pi` adapter binds
 * (session:ensure → turn:build → agent_end → learning:idle) and prints the
 * resulting memory. Under USE_FAKE the extraction subagent is a scripted
 * canonical model (list → save two memories → decline a high-risk secret); the
 * script exits non-zero if the expected memories are missing or the secret leaked.
 *
 *   USE_FAKE=1 node examples/pi/run.mjs      # offline, deterministic
 *   MEMSCRIBE_LLM_API_KEY=... node examples/pi/run.mjs   # real model (tools endpoint)
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMemScribeHarnessRuntime,
  createPiHarnessPort,
  piAdapter,
  connect,
} from "@memscribe/adapters";
import { createOpenAIChatCompletionsModel } from "@memscribe/model";
import { createFakeModel } from "../shared/fake-model.mjs";
import { transcript } from "../shared/transcript.mjs";

/** A minimal EventEmitter-ish Pi host. */
function createMockPiHost(model) {
  const listeners = new Map();
  return {
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
    async completeSimple(input) {
      const response = await model.complete({
        messages: input.messages.map(canonicalMessageFromPi),
        tools: input.tools.map(canonicalToolFromPi),
        signal: input.signal,
      });
      return piAssistantFromCanonical(response);
    },
  };
}

function textFromContent(content) {
  return (content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function canonicalMessageFromPi(message) {
  if (message.role === "toolResult") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      content: textFromContent(message.content),
    };
  }
  const toolCalls = (message.content ?? [])
    .filter((part) => part?.type === "toolCall")
    .map((part) => ({
      id: part.id,
      name: part.name,
      input: part.arguments ?? {},
    }));
  const out = {
    role: message.role,
    content: textFromContent(message.content) || null,
  };
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  return out;
}

function canonicalToolFromPi(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function piAssistantFromCanonical(response) {
  const content = [];
  if (response.message.content) content.push({ type: "text", text: response.message.content });
  for (const call of response.message.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.input ?? {},
    });
  }
  return {
    role: "assistant",
    content,
    stopReason: response.finishReason,
  };
}

const useFake = process.env.USE_FAKE === "1";
const root = await mkdtemp(path.join(tmpdir(), "memscribe-pi-"));

const model = useFake ? createFakeModel() : createOpenAIChatCompletionsModel();
const host = createMockPiHost(model);
const port = createPiHarnessPort(host);
const { scribe } = createMemScribeHarnessRuntime({ port, root });
const dispose = piAdapter.attach(scribe, host);

host.emit("session:ensure", { sessionId: "demo" });

// Prompt build: print the two recall segments. The adapter delivers a
// Promise<MemScribeContext> through the `respond` callback; await it here.
let ctxPromise;
host.emit("turn:build", {
  sessionId: "demo",
  respond: (p) => (ctxPromise = p),
});
const ctx = await ctxPromise;
console.log("[prompt-build] enabled:", ctx?.enabled);

// Turn end: drive extraction directly so we can await the write deterministically.
await scribe.onTurnEnd({ sessionId: "demo", messages: transcript });
host.emit("learning:idle", {});

const index = await readFile(path.join(root, "MEMORY.md"), "utf8").catch(() => "");
console.log("\n--- MEMORY.md ---\n" + (index || "(empty)"));

// Round-trip the host wiring install against a temp settings file.
const configPath = path.join(root, "settings.json");
const res = await connect(piAdapter, { configPath, apply: true });
console.log("\n[connect] verify ok:", res.verify?.ok, res.verify?.problems ?? []);

dispose();

if (useFake) {
  if (!/green tea|Preferred drink/.test(index)) {
    console.error("SMOKE FAIL: expected a preference memory to be written");
    process.exit(1);
  }
  if (!/Reply tone/.test(index)) {
    console.error("SMOKE FAIL: expected the subagent's second memory to be written");
    process.exit(1);
  }
  // Privacy: the high-risk secret in the transcript must never reach disk.
  if (new RegExp("sk" + "-ABCDEFabcdef").test(index)) {
    console.error("SMOKE FAIL: a high-risk secret was persisted");
    process.exit(1);
  }
}
console.log("\nOK");
