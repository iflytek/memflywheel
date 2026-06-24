import { test } from "node:test";
import assert from "node:assert/strict";

import { createPiHarnessPort, type PiModelContext } from "./pi-port.js";

test("createPiHarnessPort maps Pi native tool calls into canonical model responses", async () => {
  const events: string[] = [];
  const model = { id: "deepseek-v4-flash", provider: "deepseek" };
  const completeSimple = async (
    actualModel: unknown,
    context: PiModelContext,
    options?: Record<string, unknown>,
  ) => {
    assert.equal(actualModel, model);
    assert.equal(context.tools?.[0]?.name, "write");
    assert.ok(context.tools?.[0]?.parameters);
    assert.equal(context.systemPrompt, "You are a memory agent.");
    assert.deepEqual(context.messages, []);
    assert.equal(options?.signal, undefined);
    return {
      role: "assistant" as const,
      content: [
        { type: "text", text: "Saving that preference." },
        {
          type: "toolCall" as const,
          id: "pi_call_1",
          name: "write",
          arguments: { filePath: "preference/tea.md", content: "---\ntype: preference\nname: Tea\n---\n\nGreen tea\n" },
        },
      ],
      stopReason: "toolUse",
    };
  };
  const pi = {
    on(event: string, _handler: unknown) {
      events.push(event);
      return () => undefined;
    },
  };

  const port = createPiHarnessPort(pi, { completeSimple, piModel: model });

  assert.equal(port.name, "pi");
  assert.ok(port.capabilities.has("agentic-tool-loop"));
  assert.ok(port.capabilities.has("tool-trajectory"));

  const response = await port.model.complete({
    messages: [{ role: "system", content: "You are a memory agent." }],
    tools: [
      {
        name: "write",
        description: "Write memory file",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ],
  });

  assert.equal(response.finishReason, "toolUse");
  assert.equal(response.message.content, "Saving that preference.");
  assert.deepEqual(response.message.toolCalls, [
    {
      id: "pi_call_1",
      name: "write",
      input: { filePath: "preference/tea.md", content: "---\ntype: preference\nname: Tea\n---\n\nGreen tea\n" },
    },
  ]);

  const dispose = port.lifecycle.onTurnEnd(async () => undefined);
  dispose();
  assert.deepEqual(events, ["agent_end"]);
});

test("createPiHarnessPort forwards Pi context prompt as retrieval query", async () => {
  let contextHandler:
    | ((event: unknown, ctx: unknown) => Promise<unknown> | unknown)
    | undefined;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "context") {
        contextHandler = handler as (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
      }
      return () => undefined;
    },
  };
  const port = createPiHarnessPort(pi, {
    model: {
      async complete() {
        return { message: { role: "assistant", content: "done" } };
      },
    },
  });

  let seen: { sessionId?: string; query?: string } | undefined;
  port.lifecycle.onPromptBuild(async (event) => {
    seen = event;
    return { systemPrompt: "rules", preludePrompt: "index" };
  });
  assert.ok(contextHandler);
  await contextHandler!({ sessionId: "p1", prompt: "how do I publish?" }, {});

  assert.deepEqual(seen, { sessionId: "p1", query: "how do I publish?" });
});
