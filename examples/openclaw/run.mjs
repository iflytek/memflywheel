/**
 * Runnable OpenClaw example / smoke test (recall-only tier).
 *
 * OpenClaw support is not native-full yet. This smoke test wires explicit
 * recall-only mode; real OpenClaw native support must later map llm-runtime
 * into HostHarnessPort.
 *
 *   USE_FAKE=1 node examples/openclaw/run.mjs
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemScribeHarnessRuntime, openclawAdapter, connect } from "@memscribe/adapters";
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

const root = await mkdtemp(path.join(tmpdir(), "memscribe-openclaw-"));

const { scribe } = createMemScribeHarnessRuntime({ mode: "recall-only", root });

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

const turn = await scribe.onTurnEnd({ sessionId: "demo", messages: transcript });
console.log("[turn-end] result:", turn.result, "skipped:", turn.skipped);
host.emit("idle:watch", {});

const index = await readFile(path.join(root, "MEMORY.md"), "utf8").catch(() => "");
console.log("\n--- MEMORY.md ---\n" + (index || "(empty)"));

const configPath = path.join(root, "openclaw.json");
const res = await connect(openclawAdapter, { configPath, apply: true });
console.log("\n[connect] verify ok:", res.verify?.ok, res.verify?.problems ?? []);

dispose();

if (!turn.skipped) {
  console.error("SMOKE FAIL: OpenClaw recall-only mode must skip extraction");
  process.exit(1);
}
if (/green tea|Preferred drink|Reply tone/.test(index)) {
  console.error("SMOKE FAIL: recall-only mode must not write extracted memories");
  process.exit(1);
}
if (new RegExp("sk" + "-ABCDEFabcdef").test(index)) {
  console.error("SMOKE FAIL: a high-risk secret was persisted");
  process.exit(1);
}
console.log("\nOK");
