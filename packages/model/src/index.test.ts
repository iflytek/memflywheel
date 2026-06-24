import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAIChatCompletionsModel,
  createOpenAIEmbeddingsModel,
  type CanonicalModelCompletion,
  type CanonicalToolDefinition,
} from "./index.js";

const toolSchema = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    content: { type: "string" },
  },
  required: ["filePath", "content"],
  additionalProperties: false,
} as const;

const tools: CanonicalToolDefinition[] = [
  {
    name: "write",
    description: "Write memory file",
    inputSchema: toolSchema,
  },
];

test("OpenAI mapper serializes canonical messages and parses tool calls into structured inputs", async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: "{\"filePath\":\"preference/tea.md\",\"content\":\"Green tea\"}",
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const model: CanonicalModelCompletion = createOpenAIChatCompletionsModel({
    apiKey: "sk-test",
    endpoint: "https://model.example/v1",
    model: "test-model",
    fetchImpl,
  });

  const response = await model.complete({
    messages: [
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "glob", input: { pattern: "**/*.md" } }] },
      { role: "tool", toolCallId: "c1", content: "(none)" },
    ],
    tools,
  });

  const body = captured as {
    tools: Array<{ function: { name: string; parameters: unknown } }>;
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(body.tools[0]?.function.name, "write");
  assert.deepEqual(body.tools[0]?.function.parameters, toolSchema);
  assert.equal(
    ((body.messages[0]?.tool_calls as Array<{ function: { arguments: string } }>)[0])?.function
      .arguments,
    "{\"pattern\":\"**/*.md\"}",
  );
  assert.equal(body.messages[1]?.tool_call_id, "c1");

  assert.equal(response.finishReason, "tool_calls");
  assert.deepEqual(response.message.toolCalls, [
    {
      id: "call_1",
      name: "write",
      input: { filePath: "preference/tea.md", content: "Green tea" },
    },
  ]);
});

test("OpenAI mapper leaves provider sampling and token limit unset by default", async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const model = createOpenAIChatCompletionsModel({
    apiKey: "sk-test",
    endpoint: "https://model.example/v1",
    model: "test-model",
    fetchImpl,
  });

  await model.complete({ messages: [{ role: "user", content: "hello" }], tools });

  assert.ok(captured);
  assert.equal(Object.hasOwn(captured, "max_tokens"), false);
  assert.equal(Object.hasOwn(captured, "temperature"), false);
});

test("OpenAI mapper serializes provider sampling and token limit only when configured", async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const model = createOpenAIChatCompletionsModel({
    apiKey: "sk-test",
    endpoint: "https://model.example/v1",
    model: "test-model",
    maxTokens: 2048,
    temperature: 0.2,
    fetchImpl,
  });

  await model.complete({ messages: [{ role: "user", content: "hello" }], tools });

  assert.equal(captured?.max_tokens, 2048);
  assert.equal(captured?.temperature, 0.2);
});

test("OpenAI mapper fails on malformed provider tool arguments instead of repairing them", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: { name: "write", arguments: "{not-json" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const model = createOpenAIChatCompletionsModel({
    apiKey: "sk-test",
    fetchImpl,
  });

  await assert.rejects(
    () => model.complete({ messages: [{ role: "user", content: "x" }], tools }),
    /invalid JSON tool arguments/,
  );
});

test("OpenAI embeddings mapper calls /embeddings and returns canonical vectors", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  let captured: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string>).authorization);
    captured = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const embeddings = createOpenAIEmbeddingsModel({
    apiKey: "sk-test",
    endpoint: "https://embedding.example/v1",
    model: "@cf/baai/bge-m3",
    fetchImpl,
  });

  const result = await embeddings.embed({ texts: ["release", "tea"] });

  assert.equal(capturedUrl, "https://embedding.example/v1/embeddings");
  assert.equal(capturedAuth, "Bearer sk-test");
  assert.deepEqual(captured, { model: "@cf/baai/bge-m3", input: ["release", "tea"] });
  assert.deepEqual(result.vectors, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ]);
});

test("OpenAI embeddings mapper fails on invalid vector counts", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const embeddings = createOpenAIEmbeddingsModel({
    apiKey: "sk-test",
    fetchImpl,
  });

  await assert.rejects(() => embeddings.embed({ texts: ["a", "b"] }), /invalid embedding count/);
});
