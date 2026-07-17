/**
 * OpenClaw chat simulator for K8s e2e test.
 *
 * OpenClaw runs as a gateway; its plugin API exposes hooks but not a direct
 * model-call interface. This script simulates an OpenClaw session by:
 *   1. Creating a mock OpenClaw host (event emitter)
 *   2. Loading the memflywheel adapter + runtime
 *   3. Emitting lifecycle events (before_agent_start, context:inject, agent_end, idle:watch)
 *   4. The runtime handles recall and records the turn for later extraction
 *
 * Usage: node /e2e/openclaw/chat.mjs "prompt text"
 */

import { createMemFlywheelHarnessRuntime, openclawAdapter } from "@iflytekopensource/adapters";

const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: node chat.mjs <prompt>");
  process.exit(1);
}

const root = process.env.MEMFLYWHEEL_ROOT || "/home/node/.openclaw/memflywheel";

// ─── mock OpenClaw host (event emitter) ────────────────────────────────────

const listeners = new Map();

const host = {
  on(event, fn) {
    const set = listeners.get(event) ?? new Set();
    set.add(fn);
    listeners.set(event, set);
    return () => set.delete(fn);
  },
  emit(event, payload) {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  },
  registerMemoryCapability(cap) {
    host._memoryCapability = cap;
  },
};

// ─── load memflywheel runtime ──────────────────────────────────────────────

const { scribe } = createMemFlywheelHarnessRuntime({ mode: "recall-only", root });
openclawAdapter.attach(scribe, host);

// ─── simulate lifecycle ────────────────────────────────────────────────────

// Session start
host.emit("before_agent_start", { agentId: "e2e" });

// Prompt build — get memory context (recall)
let memoryContext;
host.emit("context:inject", {
  agentId: "e2e",
  respond: (p) => {
    memoryContext = p;
  },
});

// Forward turn to memflywheel (transcript recording)
host.emit("agent_end", {
  agentId: "e2e",
  messages: [
    { role: "user", content: prompt },
    { role: "assistant", content: "Got it! I'll remember that for next time." },
  ],
});

// Flush / idle
host.emit("idle:watch", {});

// Wait a moment for async operations
await new Promise((r) => setTimeout(r, 1000));

console.log(
  JSON.stringify({
    ok: true,
    hasMemoryContext: Boolean(memoryContext?.preludePrompt),
    prompt: prompt.slice(0, 60),
  }),
);
