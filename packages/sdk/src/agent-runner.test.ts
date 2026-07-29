import { test } from "node:test";
import assert from "node:assert/strict";

import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";

import { runMemoryAgent } from "./agent-runner.js";
import { scriptedBinding, stopTurn } from "./agent-test-support.test.js";

test("runMemoryAgent releases pi-ai resources for its isolated session", async () => {
  const scripted = scriptedBinding([stopTurn]);
  const cleaned: Array<string | undefined> = [];
  const unregister = registerSessionResourceCleanup((sessionId) => cleaned.push(sessionId));
  try {
    await runMemoryAgent({
      resolveModel: async () => ({
        ...(await scripted.resolveModel()),
        sessionId: "memflywheel:test-session",
      }),
      tools: [],
      systemPrompt: "test",
      userMessage: "test",
    });
    assert.deepEqual(cleaned, ["memflywheel:test-session"]);
  } finally {
    unregister();
  }
});

test("host request options override undefined Agent Core defaults", async () => {
  const scripted = scriptedBinding([stopTurn]);
  let receivedTemperature: unknown;

  await runMemoryAgent({
    resolveModel: async () => {
      const binding = await scripted.resolveModel();
      return {
        ...binding,
        request: { temperature: 0.25 },
        streamFn: (model, context, options) => {
          receivedTemperature = (options as Record<string, unknown> | undefined)?.temperature;
          return binding.streamFn(model, context, options);
        },
      };
    },
    tools: [],
    systemPrompt: "test",
    userMessage: "test",
  });

  assert.equal(receivedTemperature, 0.25);
});
