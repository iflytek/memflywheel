import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  registerSessionResourceCleanup,
  Type,
  type JsonObject,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

import { runMemoryAgent } from "./agent-runner.js";
import { scriptedBinding, stopTurn, toolTurn } from "./agent-test-support.test.js";

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

test("memory agent carries instructions, tool declarations and results in the transcript", async () => {
  const args: JsonObject = { facts: ["tea", null, 2], enabled: true };
  const scripted = scriptedBinding([toolTurn("remember", args), stopTurn]);
  const contexts: TranscriptContext[] = [];
  let receivedArgs: unknown;
  const result = await runMemoryAgent({
    resolveModel: async () => {
      const binding = await scripted.resolveModel();
      return {
        ...binding,
        streamFn: (model, context, options) => {
          contexts.push(normalizeContext({ messages: structuredClone(context.messages) }));
          return binding.streamFn(model, context, options);
        },
      };
    },
    tools: [
      {
        name: "remember",
        description: "store facts",
        inputSchema: Type.Object({ facts: Type.Array(Type.Unknown()), enabled: Type.Boolean() }),
        execute: async (input) => {
          receivedArgs = input;
          return { ok: true, text: "Stored tea.", changed: ["tea.md"] };
        },
      },
    ],
    systemPrompt: "Remember durable facts.",
    userMessage: "Remember tea.",
  });

  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]?.messages[0]?.role, "system");
  assert.equal(getCurrentSystemPrompt(contexts[0]?.messages ?? []), "Remember durable facts.");
  assert.deepEqual(
    getCurrentTools(contexts[0]?.messages ?? []).map((tool) => tool.name),
    ["remember"],
  );
  const toolResult = contexts[1]?.messages.find((message) => message.role === "toolResult");
  assert.deepEqual(toolResult?.content, [{ type: "text", text: "Stored tea." }]);
  assert.deepEqual(receivedArgs, args);
  assert.deepEqual(result.changed, ["tea.md"]);
  assert.equal(result.finalContent, "done");
});

test("memory agent releases isolated session resources after provider failure", async () => {
  const scripted = scriptedBinding([]);
  const cleaned: Array<string | undefined> = [];
  const unregister = registerSessionResourceCleanup((sessionId) => cleaned.push(sessionId));
  try {
    await assert.rejects(
      runMemoryAgent({
        resolveModel: async () => ({
          ...(await scripted.resolveModel()),
          sessionId: "memflywheel:failed-session",
          streamFn: () => {
            throw new Error("provider failed");
          },
        }),
        tools: [],
        systemPrompt: "test",
        userMessage: "test",
      }),
      /provider failed/,
    );
    assert.deepEqual(cleaned, ["memflywheel:failed-session"]);
  } finally {
    unregister();
  }
});
