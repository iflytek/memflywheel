/**
 * Runnable Pi example / smoke test.
 *
 * Drives a Pi-shaped host through the real Pi lifecycle events
 * (session_start → context → agent_end → session_shutdown) and prints the
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
function createMockPiHost() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    async emit(event, payload, ctx) {
      const results = [];
      for (const fn of listeners.get(event) ?? []) {
        results.push(await fn(payload, ctx));
      }
      return results;
    },
  };
}

function piMessagesFromTranscript(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.text }],
  }));
}

const useFake = process.env.USE_FAKE === "1";
const root = await mkdtemp(path.join(tmpdir(), "memscribe-pi-"));

const model = useFake ? createFakeModel() : createOpenAIChatCompletionsModel();
const host = createMockPiHost();
const port = createPiHarnessPort(host, { model });
const { scribe, dispose } = createMemScribeHarnessRuntime({ port, root });

await host.emit("session_start", { sessionId: "demo" });

// Prompt build: Pi's context hook returns the transformed message list.
const contextResults = await host.emit("context", { sessionId: "demo", messages: [] });
console.log("[context] injected messages:", contextResults.at(-1)?.messages?.length ?? 0);

await host.emit("agent_end", { sessionId: "demo", messages: piMessagesFromTranscript(transcript) });
await scribe.onIdle({ force: true });
await host.emit("session_shutdown", { sessionId: "demo" });

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
