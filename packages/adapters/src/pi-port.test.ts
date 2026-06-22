import { test } from "node:test";
import assert from "node:assert/strict";

import { createPiHarnessPort } from "./pi-port.js";

test("createPiHarnessPort maps Pi native tool calls into canonical model responses", async () => {
  const events: string[] = [];
  const pi = {
    on(event: string, _handler: unknown) {
      events.push(event);
      return () => undefined;
    },
    async completeSimple(input: {
      messages: unknown[];
      tools: Array<Record<string, unknown>>;
      signal?: AbortSignal;
    }) {
      assert.equal(input.tools[0]?.name, "write");
      assert.equal((input.messages[0] as { role?: string }).role, "system");
      assert.equal(input.signal, undefined);
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
    },
  };

  const port = createPiHarnessPort(pi);

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
