import { test } from "node:test";
import assert from "node:assert/strict";

import type { MemScribeContext } from "./adapter.js";
import { piAdapter } from "./pi.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { hermesAdapter } from "./hermes.js";
import {
  createFakeHost,
  createOffHost,
  createRecordingMemScribe,
} from "./test-helpers.js";

const flush = () => new Promise((r) => setImmediate(r));

test("attach binds each host event to its scribe hook (pi)", async () => {
  const scribe = createRecordingMemScribe();
  const host = createFakeHost();
  const dispose = piAdapter.attach(scribe, host);

  host.emit("session_start", { sessionId: "s1" });
  host.emit("context", { sessionId: "s1", prompt: "how do I release this package?", messages: [] });
  host.emit("agent_end", {
    sessionId: "s1",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ],
  });
  host.emit("session_shutdown", { sessionId: "s1" });
  await flush();

  assert.deepEqual(scribe.calls.sessionStart, [{ sessionId: "s1" }]);
  assert.deepEqual(scribe.calls.promptBuild, [{ sessionId: "s1", query: "how do I release this package?" }]);
  assert.equal(scribe.calls.turnEnd.length, 1);
  assert.equal(scribe.calls.turnEnd[0]?.sessionId, "s1");
  assert.deepEqual(scribe.calls.turnEnd[0]?.messages, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "yo" },
  ]);
  assert.deepEqual(scribe.calls.sessionEnd, [{ sessionId: "s1" }]);

  dispose();
});

test("dispose removes all listeners (on-returns-unsubscribe path)", async () => {
  const scribe = createRecordingMemScribe();
  const host = createFakeHost();
  const dispose = piAdapter.attach(scribe, host);
  assert.equal(host.listenerCount("session_start"), 1);
  dispose();
  assert.equal(host.listenerCount("session_start"), 0);

  host.emit("session_start", { sessionId: "ghost" });
  await flush();
  assert.equal(scribe.calls.sessionStart.length, 0);
});

test("dispose works through host.off when on returns void", async () => {
  const scribe = createRecordingMemScribe();
  const host = createOffHost();
  const dispose = piAdapter.attach(scribe, host);
  assert.equal(host.listenerCount("agent_end"), 1);
  dispose();
  assert.equal(host.listenerCount("agent_end"), 0);
});

test("onPromptBuild result is delivered via a respond callback", async () => {
  const scribe = createRecordingMemScribe({ systemPrompt: "RULES", preludePrompt: "PRELUDE" });
  const host = createFakeHost();
  claudeCodeAdapter.attach(scribe, host);

  let received: MemScribeContext | undefined;
  host.emit("UserPromptSubmit", {
    session_id: "abc",
    prompt: "review this release",
    respond: (p: Promise<MemScribeContext>) => {
      void p.then((ctx) => {
        received = ctx;
      });
    },
  });
  await flush();

  assert.deepEqual(scribe.calls.promptBuild, [{ sessionId: "abc", query: "review this release" }]);
  assert.ok(received);
  assert.equal(received!.systemPrompt, "RULES");
  assert.equal(received!.preludePrompt, "PRELUDE");
});

test("turn-end extraction is fire-and-forget — emit does not throw on scribe rejection", async () => {
  const host = createFakeHost();
  const scribe = createRecordingMemScribe();
  // Replace onTurnEnd with one that rejects.
  const rejecting = {
    ...scribe,
    onTurnEnd: async () => {
      throw new Error("extraction subagent blew up");
    },
  };
  const dispose = hermesAdapter.attach(rejecting, host);
  // Must not throw synchronously despite the rejection.
  assert.doesNotThrow(() => host.emit("post_llm_call", { session_id: "c1", transcript: [] }));
  await flush();
  dispose();
});

test("claude-code maps snake_case session_id and Stop turn-end", async () => {
  const scribe = createRecordingMemScribe();
  const host = createFakeHost();
  const dispose = claudeCodeAdapter.attach(scribe, host);

  host.emit("SessionStart", { session_id: "cc-1" });
  host.emit("Stop", { session_id: "cc-1", messages: [{ role: "user", content: "remember X" }] });
  await flush();

  assert.deepEqual(scribe.calls.sessionStart, [{ sessionId: "cc-1" }]);
  assert.equal(scribe.calls.turnEnd[0]?.sessionId, "cc-1");
  // `content` is normalized to `text`.
  assert.deepEqual(scribe.calls.turnEnd[0]?.messages, [{ role: "user", text: "remember X" }]);
  dispose();
});

test("hermes reads session_id and user_message/assistant_response", async () => {
  const scribe = createRecordingMemScribe();
  const host = createFakeHost();
  const dispose = hermesAdapter.attach(scribe, host);

  host.emit("on_session_start", { session_id: "h1" });
  host.emit("post_llm_call", {
    session_id: "h1",
    user_message: "remember I like tea",
    assistant_response: "noted",
  });
  host.emit("on_session_end", { force: true });
  await flush();

  assert.deepEqual(scribe.calls.sessionStart, [{ sessionId: "h1" }]);
  assert.equal(scribe.calls.turnEnd[0]?.sessionId, "h1");
  assert.deepEqual(scribe.calls.turnEnd[0]?.messages, [
    { role: "user", text: "remember I like tea" },
    { role: "assistant", text: "noted" },
  ]);
  assert.deepEqual(scribe.calls.idle, [{ force: true }]);
  dispose();
});

test("hermes still accepts an explicit transcript array", async () => {
  const scribe = createRecordingMemScribe();
  const host = createFakeHost();
  const dispose = hermesAdapter.attach(scribe, host);

  host.emit("post_llm_call", {
    session_id: "h2",
    transcript: [{ role: "assistant", text: "ok" }],
  });
  await flush();

  assert.equal(scribe.calls.turnEnd[0]?.sessionId, "h2");
  assert.deepEqual(scribe.calls.turnEnd[0]?.messages, [{ role: "assistant", text: "ok" }]);
  dispose();
});
