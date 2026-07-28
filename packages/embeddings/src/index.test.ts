import { test } from "node:test";
import assert from "node:assert/strict";

import { createOpenAIEmbeddingsModel } from "./index.js";

test("embedding provider batches requests and preserves vector order", async () => {
  const bodies: unknown[] = [];
  const model = createOpenAIEmbeddingsModel({
    endpoint: "https://embedding.test/v1/",
    apiKey: "secret",
    model: "bge-m3",
    batchSize: 2,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      bodies.push(body);
      return new Response(
        JSON.stringify({ data: body.input.map((text) => ({ embedding: [text.length, 1] })) }),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(await model.embed({ texts: ["a", "bb", "ccc"] }), {
    vectors: [
      [1, 1],
      [2, 1],
      [3, 1],
    ],
  });
  assert.deepEqual(bodies, [
    { model: "bge-m3", input: ["a", "bb"] },
    { model: "bge-m3", input: ["ccc"] },
  ]);
});

test("embedding provider rejects malformed vectors", async () => {
  const model = createOpenAIEmbeddingsModel({
    apiKey: "secret",
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ embedding: [] }] })),
  });
  await assert.rejects(() => model.embed({ texts: ["x"] }), /invalid vector/);
});
