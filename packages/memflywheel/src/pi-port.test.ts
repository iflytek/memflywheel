import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

import { createPiHarnessPort, type PiExtensionHandler, type PiStreamSimple } from "./pi-port.js";

function fakePi() {
  const handlers = new Map<string, PiExtensionHandler>();
  return {
    handlers,
    api: {
      on(event: string, handler: PiExtensionHandler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
  };
}

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-codex-responses" as const,
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text" as const, "image" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done", textSignature: "native-signature" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: "resp_native",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("Pi port resolves the active model, auth, thinking level, and isolated session", async () => {
  const { api, handlers } = fakePi();
  let capturedApiKey: string | undefined;
  const streamSimple: PiStreamSimple = (_model, _context, options) => {
    capturedApiKey = options?.apiKey;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistant() });
    return stream;
  };
  const port = createPiHarnessPort(api, { streamSimple });
  port.lifecycle.onPromptBuild(async () => ({}));

  await handlers.get("context")?.(
    { sessionId: "chat-1", messages: [{ role: "user", content: "remember tea" }] },
    {
      mode: "json",
      model,
      sessionManager: { getSessionId: () => "chat-1" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "host-oauth" }),
      },
      getThinkingLevel: () => "high",
    },
  );

  const binding = await port.resolveModel();
  assert.strictEqual(binding.model, model);
  assert.equal(binding.thinkingLevel, "high");
  assert.equal(binding.transport, "sse");
  assert.equal(binding.sessionId, "memflywheel:chat-1");
  const response = await (
    await binding.streamFn(
      binding.model,
      { messages: [] },
      { apiKey: await binding.getApiKey?.("x") },
    )
  ).result();
  assert.equal(capturedApiKey, "host-oauth");
  assert.equal(response.usage.totalTokens, 17);
  assert.equal(response.responseId, "resp_native");
});

test("Pi context forwards the latest user query into progressive recall", async () => {
  const { api, handlers } = fakePi();
  const port = createPiHarnessPort(api, {
    resolveModel: async () => {
      throw new Error("unused");
    },
  });
  let query: string | undefined;
  port.lifecycle.onPromptBuild(async (event) => {
    query = event.query;
    return { preludePrompt: "memory index" };
  });
  const result = await handlers.get("context")?.({
    messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "latest query" }] },
    ],
  });
  assert.equal(query, "latest query");
  assert.equal((result as { messages: unknown[] }).messages.length, 4);
});

test("Pi turn-end learning runs off the foreground event and drains before shutdown", async () => {
  const { api, handlers } = fakePi();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const port = createPiHarnessPort(api, {
    resolveModel: async () => {
      throw new Error("unused");
    },
    afterTurnEnd: () => void order.push("sync"),
  });
  port.lifecycle.onTurnEnd(async (event) => {
    order.push(`start:${event.sessionId}`);
    if (event.sessionId === "s1") await firstBlocked;
    order.push(`end:${event.sessionId}`);
  });
  port.lifecycle.onSessionEnd(async (event) => void order.push(`shutdown:${event.sessionId}`));

  const firstReturn = handlers.get("agent_end")?.({ sessionId: "s1", messages: [] }, {});
  const secondReturn = handlers.get("agent_end")?.({ sessionId: "s2", messages: [] }, {});
  assert.equal(firstReturn, undefined);
  assert.equal(secondReturn, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:s1"]);

  const shutdown = handlers.get("session_shutdown")?.({ sessionId: "s2" }, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:s1"]);
  releaseFirst?.();
  await shutdown;
  assert.deepEqual(order, [
    "start:s1",
    "end:s1",
    "sync",
    "start:s2",
    "end:s2",
    "sync",
    "shutdown:s2",
  ]);
});

test("Pi reports background learning failures and rejects shutdown after the final sweep", async () => {
  const { api, handlers } = fakePi();
  const notifications: string[] = [];
  const order: string[] = [];
  const port = createPiHarnessPort(api, {
    resolveModel: async () => {
      throw new Error("unused");
    },
  });
  port.lifecycle.onTurnEnd(async () => {
    throw new Error("model unavailable");
  });
  port.lifecycle.onSessionEnd(async () => void order.push("final-sweep"));

  handlers.get("agent_end")?.(
    { sessionId: "s1", messages: [] },
    { ui: { notify: (message) => notifications.push(message) } },
  );
  const shutdown = Promise.resolve(handlers.get("session_shutdown")?.({ sessionId: "s1" }, {}));
  await assert.rejects(shutdown, /background learning failed/);
  assert.deepEqual(order, ["final-sweep"]);
  assert.deepEqual(notifications, ["MemFlywheel background learning failed: model unavailable"]);
});
