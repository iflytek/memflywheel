import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hostMessagesFromOpenCodeSessionMessages,
  configureOpenCodeMemoryPermission,
  createOpenCodeHarnessPort,
  piApiForOpenCodeTransport,
} from "./opencode-port.js";
import { resolveTestModel, type TestModelCompletion } from "./model-test-support.test.js";

const fakeModel: TestModelCompletion = {
  async complete() {
    return { message: { role: "assistant", content: "done" } };
  },
};

function openCodeModel(npm: string, id: string, url: string) {
  return {
    id,
    providerID: "test-provider",
    name: id,
    api: { id, npm, url },
    capabilities: { reasoning: false, input: { text: true, image: false } },
    limit: { context: 128_000, output: 8_192 },
    headers: {},
  };
}

test("configureOpenCodeMemoryPermission grants every session the memory root", () => {
  const config: { permission?: unknown } = {
    permission: { read: { "*.env": "deny" }, external_directory: { "*": "ask" } },
  };
  configureOpenCodeMemoryPermission(config, "/Users/test/.config/opencode/memflywheel");
  assert.deepEqual(config.permission, {
    read: { "*.env": "deny" },
    external_directory: {
      "*": "ask",
      "/Users/test/.config/opencode/memflywheel/*": "allow",
    },
  });
});

test("OpenCode transcript conversion preserves tool inputs and outputs", () => {
  assert.deepEqual(
    hostMessagesFromOpenCodeSessionMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "remember tea" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "working" },
          {
            type: "tool",
            tool: "read",
            callID: "c1",
            state: { status: "completed", input: { path: "MEMORY.md" }, output: "empty" },
          },
        ],
      },
    ]),
    [
      { role: "user", content: "remember tea" },
      {
        role: "assistant",
        content: "working",
        toolCalls: [{ id: "c1", name: "read", input: { path: "MEMORY.md" } }],
      },
      { role: "tool", toolCallId: "c1", content: "empty" },
    ],
  );
});

test("OpenCode port injects recall and forwards the real idle transcript", async () => {
  const client = {
    session: {
      messages: async () => ({
        data: [{ info: { role: "user" }, parts: [{ type: "text", text: "remember tea" }] }],
      }),
    },
  };
  const port = createOpenCodeHarnessPort(client, {
    resolveModel: resolveTestModel(fakeModel),
  });
  port.lifecycle.onPromptBuild(async () => ({
    systemPrompt: "rules",
    preludePrompt: "index",
    skillPreludePrompt: "skills",
  }));
  const turns: unknown[] = [];
  port.lifecycle.onTurnEnd(async (turn) => void turns.push(turn));

  const output = { system: [] as string[] };
  await port.hooks["experimental.chat.system.transform"]({ sessionID: "oc-1" }, output);
  await port.hooks.event({ event: { type: "session.idle", properties: { sessionID: "oc-1" } } });

  assert.deepEqual(output.system, ["rules", "index", "skills"]);
  assert.deepEqual(turns, [
    { sessionId: "oc-1", messages: [{ role: "user", content: "remember tea" }] },
  ]);
});

test("OpenCode buffers text-complete without blocking output, then serializes idle delivery", async () => {
  let transcript = {
    data: [{ info: { role: "user" }, parts: [{ type: "text", text: "remember tea" }] }],
  };
  const port = createOpenCodeHarnessPort(
    { session: { messages: async () => transcript } },
    { resolveModel: resolveTestModel(fakeModel) },
  );
  const turns: unknown[] = [];
  port.lifecycle.onTurnEnd(async (turn) => void turns.push(turn));

  await port.hooks["experimental.text.complete"](
    { sessionID: "oc-idle", messageID: "m1", partID: "p1" },
    { text: "noted" },
  );
  assert.equal(turns.length, 0);

  const idle = { event: { type: "session.idle", properties: { sessionID: "oc-idle" } } };
  await Promise.all([port.hooks.event(idle), port.hooks.event(idle)]);
  assert.deepEqual(turns, [
    {
      sessionId: "oc-idle",
      messages: [
        { role: "user", content: "remember tea" },
        { role: "assistant", content: "noted" },
      ],
    },
  ]);

  transcript = {
    data: [
      { info: { role: "user" }, parts: [{ type: "text", text: "remember tea" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "noted" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "and coffee" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "also noted" }] },
    ],
  };
  await port.hooks.event(idle);
  assert.equal(turns.length, 2);
});

test("OpenCode port fails before chat.params supplies the active model", async () => {
  const port = createOpenCodeHarnessPort({});
  await assert.rejects(
    async () => port.resolveModel(),
    /has not received OpenCode's active model context/,
  );
});

test("OpenCode resolves DeepSeek and Anthropic directly into pi-ai model bindings", async () => {
  for (const [npm, id, url, expectedApi, expectedBaseUrl] of [
    [
      "@ai-sdk/openai-compatible",
      "deepseek-chat",
      "https://api.deepseek.com",
      "openai-completions",
      "https://api.deepseek.com",
    ],
    [
      "@ai-sdk/anthropic",
      "x2p",
      "https://anthropic-gateway.example.com/v1",
      "anthropic-messages",
      "https://anthropic-gateway.example.com",
    ],
  ] as const) {
    const port = createOpenCodeHarnessPort({});
    await port.hooks["chat.params"](
      {
        sessionID: "oc-model",
        model: openCodeModel(npm, id, url),
        provider: { id: expectedApi, source: "api", key: "host-owned", options: {} },
      },
      { maxOutputTokens: 4096, options: {} },
    );
    const binding = await port.resolveModel();
    assert.equal(binding.model.api, expectedApi);
    assert.equal(binding.model.baseUrl, expectedBaseUrl);
    assert.equal(binding.model.id, id);
    assert.equal(await binding.getApiKey?.(binding.model.provider), "host-owned");
    assert.equal(binding.request?.maxTokens, 4096);
  }
});

test("OpenCode transport mapping is exact and rejects unknown transports", () => {
  assert.deepEqual(
    [
      "@ai-sdk/openai-compatible",
      "@ai-sdk/openai",
      "@ai-sdk/azure",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@ai-sdk/google-vertex",
      "@ai-sdk/amazon-bedrock",
      "@ai-sdk/mistral",
    ].map((apiPackage) => piApiForOpenCodeTransport(apiPackage)),
    [
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "anthropic-messages",
      "google-generative-ai",
      "google-vertex",
      "bedrock-converse-stream",
      "mistral-conversations",
    ],
  );
  assert.throws(() => piApiForOpenCodeTransport("@ai-sdk/unknown"), /no exact pi-ai API mapping/);
  assert.equal(
    piApiForOpenCodeTransport("@ai-sdk/openai", "openai-codex"),
    "openai-codex-responses",
  );
});
