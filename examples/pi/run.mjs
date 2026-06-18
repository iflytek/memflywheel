/**
 * Runnable Pi example / smoke test.
 *
 * Drives a mock Pi host through the four lifecycle events the `pi` adapter binds
 * (session:ensure → turn:build → agent_end → learning:idle) and prints the
 * resulting memory. Under USE_FAKE the extraction subagent is a scripted
 * tool-completion (list → save two memories → decline a high-risk secret); the
 * script exits non-zero if the expected memories are missing or the secret leaked.
 *
 *   USE_FAKE=1 node examples/pi/run.mjs      # offline, deterministic
 *   MEMSCRIBE_LLM_API_KEY=... node examples/pi/run.mjs   # real model (tools endpoint)
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostMemScribe, piAdapter, connect } from "@memscribe/adapters";
import { defaultExtractionAgentFromEnv } from "@memscribe/sdk";
import { createFakeToolCompletion } from "../shared/fake-tool-completion.mjs";
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
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
  };
}

const useFake = process.env.USE_FAKE === "1";
const root = await mkdtemp(path.join(tmpdir(), "memscribe-pi-"));

// Real path: Pi would wrap its auxiliary tool-calling completion; here we fall
// back to the default fetch tool-completion (env-driven) when not using the
// fake. The fake plays a multi-step subagent: list → save → decline.
const { scribe } = useFake
  ? createHostMemScribe({ toolCompletion: createFakeToolCompletion(), root })
  : createHostMemScribe({ agent: defaultExtractionAgentFromEnv(), root });

const host = createMockPiHost();
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
