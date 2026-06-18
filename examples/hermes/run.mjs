/**
 * Runnable Hermes example / smoke test.
 *
 * Drives a mock Hermes host through the real hook names the `hermes` adapter
 * binds (on_session_start → pre_llm_call → post_llm_call → on_session_end) and
 * prints the resulting memory. Under USE_FAKE the extraction subagent is a
 * scripted tool-completion (list → save → decline a high-risk secret).
 *
 *   USE_FAKE=1 node examples/hermes/run.mjs
 *   MEMSCRIBE_LLM_API_KEY=... node examples/hermes/run.mjs   # real model (tools endpoint)
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostMemScribe, hermesAdapter, connect } from "@memscribe/adapters";
import { defaultExtractionAgentFromEnv } from "@memscribe/sdk";
import { createFakeToolCompletion } from "../shared/fake-tool-completion.mjs";
import { transcript } from "../shared/transcript.mjs";

function createMockHermesHost() {
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
const root = await mkdtemp(path.join(tmpdir(), "memscribe-hermes-"));

const { scribe } = useFake
  ? createHostMemScribe({ toolCompletion: createFakeToolCompletion(), root })
  : createHostMemScribe({ agent: defaultExtractionAgentFromEnv(), root });

const host = createMockHermesHost();
const dispose = hermesAdapter.attach(scribe, host);

host.emit("on_session_start", { session_id: "demo" });

let ctxPromise;
host.emit("pre_llm_call", {
  session_id: "demo",
  respond: (p) => (ctxPromise = p),
});
const ctx = await ctxPromise;
console.log("[prompt-build] enabled:", ctx?.enabled);

// Hermes post_llm_call exposes user_message + assistant_response.
await scribe.onTurnEnd({ sessionId: "demo", messages: transcript });
host.emit("on_session_end", { session_id: "demo" });

const index = await readFile(path.join(root, "MEMORY.md"), "utf8").catch(() => "");
console.log("\n--- MEMORY.md ---\n" + (index || "(empty)"));

const configPath = path.join(root, "hermes-config.json");
const res = await connect(hermesAdapter, { configPath, apply: true });
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
  if (new RegExp("sk" + "-ABCDEFabcdef").test(index)) {
    console.error("SMOKE FAIL: a high-risk secret was persisted");
    process.exit(1);
  }
}
console.log("\nOK");
