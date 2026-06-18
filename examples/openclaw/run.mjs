/**
 * Runnable OpenClaw example / smoke test (best-effort tier).
 *
 * OpenClaw cannot supply a host model channel, so the extraction subagent uses
 * MemScribe's default fetch tool-completion. Under USE_FAKE=1 we inject a scripted
 * fake tool-completion so the smoke test runs offline; the real path uses
 * defaultExtractionAgentFromEnv().
 *
 *   USE_FAKE=1 node examples/openclaw/run.mjs
 *   MEMSCRIBE_LLM_API_KEY=... node examples/openclaw/run.mjs   # real model (tools endpoint)
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostMemScribe, openclawAdapter, connect } from "@memscribe/adapters";
import { defaultExtractionAgentFromEnv } from "@memscribe/sdk";
import { createFakeToolCompletion } from "../shared/fake-tool-completion.mjs";
import { transcript } from "../shared/transcript.mjs";

function createMockOpenClawHost() {
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
const root = await mkdtemp(path.join(tmpdir(), "memscribe-openclaw-"));

// Best-effort: the extraction subagent runs on the default fetch tool-completion
// (or a scripted fake offline).
const { scribe } = useFake
  ? createHostMemScribe({ toolCompletion: createFakeToolCompletion(), root })
  : createHostMemScribe({ agent: defaultExtractionAgentFromEnv(), root });

const host = createMockOpenClawHost();
const dispose = openclawAdapter.attach(scribe, host);

host.emit("before_agent_start", { agentId: "demo" });

let ctxPromise;
host.emit("context:inject", {
  agentId: "demo",
  respond: (p) => (ctxPromise = p),
});
const ctx = await ctxPromise;
console.log("[prompt-build] prependContext present:", Boolean(ctx?.preludePrompt));

await scribe.onTurnEnd({ sessionId: "demo", messages: transcript });
host.emit("idle:watch", {});

const index = await readFile(path.join(root, "MEMORY.md"), "utf8").catch(() => "");
console.log("\n--- MEMORY.md ---\n" + (index || "(empty)"));

const configPath = path.join(root, "openclaw.json");
const res = await connect(openclawAdapter, { configPath, apply: true });
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
