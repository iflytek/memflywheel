import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeContext, type Api } from "@earendil-works/pi-ai";

import { createPiAiModelBinding } from "./opencode-pi-model.js";

function binding(api: Api, fetch?: typeof globalThis.fetch) {
  return createPiAiModelBinding({
    api,
    provider: "test",
    model: "test-model",
    name: "test-model",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 16_384,
    maxTokens: 4_096,
    fetch,
  });
}

test("unsupported host fetch transports fail before loading a provider", async () => {
  let calls = 0;
  const hostFetch: typeof globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected request");
  };
  for (const api of ["bedrock-converse-stream", "google-generative-ai", "google-vertex"]) {
    const model = binding(api, hostFetch);
    await assert.rejects(
      async () => model.streamFn(model.model, normalizeContext({ messages: [] })),
      new RegExp(`OpenCode host fetch is not supported by ${api}`),
    );
    assert.equal(binding(api).model.api, api);
  }
  assert.equal(calls, 0);
});

test("Codex host fetch rejects explicit WebSocket transports", async () => {
  let calls = 0;
  const model = binding("openai-codex-responses", async () => {
    calls += 1;
    throw new Error("unexpected request");
  });
  for (const transport of ["websocket", "websocket-cached"] as const) {
    await assert.rejects(
      async () => model.streamFn(model.model, normalizeContext({ messages: [] }), { transport }),
      /host fetch requires SSE/,
    );
  }
  assert.equal(calls, 0);
});

test("Codex host fetch uses SSE without attempting a default request or WebSocket", async () => {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const websocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let defaultRequests = 0;
  let websocketRequests = 0;
  let hostRequests = 0;
  const apiKey = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      defaultRequests += 1;
      throw new Error("unexpected default request");
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class {
      constructor() {
        websocketRequests += 1;
        throw new Error("unexpected WebSocket request");
      }
    },
  });
  try {
    const model = binding("openai-codex-responses", async () => {
      hostRequests += 1;
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "test-response",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    for (const transport of [undefined, "auto", "sse"] as const) {
      const stream = await model.streamFn(
        model.model,
        normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] }),
        { apiKey, transport, maxRetries: 0 },
      );
      assert.equal((await stream.result()).stopReason, "stop");
    }
    assert.equal(hostRequests, 3);
    assert.equal(defaultRequests, 0);
    assert.equal(websocketRequests, 0);
  } finally {
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (websocketDescriptor) Object.defineProperty(globalThis, "WebSocket", websocketDescriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});
