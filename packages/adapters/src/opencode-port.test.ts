import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalMessagesFromOpenCodeSessionMessages,
  createOpenCodeHarnessPort,
  type OpenCodeClientLike,
} from "./opencode-port.js";
import type { CanonicalModelCompletion } from "@memflywheel/model";

const fakeModel: CanonicalModelCompletion = {
  async complete() {
    return { message: { role: "assistant", content: "done" } };
  },
};

function openCodeTranscript() {
  return {
    data: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "please inspect files" }],
      },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "I will inspect them." },
          {
            type: "tool",
            callID: "tool-1",
            tool: "read",
            state: { status: "completed", input: { filePath: "README.md" }, output: "contents" },
          },
        ],
      },
    ],
  };
}

function openCodeUserOnlyTranscript() {
  return {
    data: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "remember apples" }],
      },
    ],
  };
}

test("canonicalMessagesFromOpenCodeSessionMessages folds tool parts into assistant messages", () => {
  assert.deepEqual(canonicalMessagesFromOpenCodeSessionMessages(openCodeTranscript()), [
    { role: "user", content: "please inspect files" },
    {
      role: "assistant",
      content: "I will inspect them.",
      toolCalls: [{ id: "tool-1", name: "read", input: { filePath: "README.md" } }],
    },
    { role: "tool", toolCallId: "tool-1", content: "contents" },
  ]);
});

test("createOpenCodeHarnessPort injects prompt context and forwards idle transcript", async () => {
  let readOptions: unknown;
  const client: OpenCodeClientLike = {
    session: {
      async messages(options) {
        readOptions = options;
        return openCodeTranscript();
      },
    },
  };
  const port = createOpenCodeHarnessPort(client, { model: fakeModel });
  const seenTurns: unknown[] = [];
  const seenPromptEvents: unknown[] = [];

  port.lifecycle.onPromptBuild(async (event) => ({
    systemPrompt: `system:${event.sessionId}:${event.query}`,
    preludePrompt: "memory",
    skillPreludePrompt: "skill",
  }));
  port.lifecycle.onPromptBuild(async (event) => {
    seenPromptEvents.push(event);
    return {};
  });
  port.lifecycle.onTurnEnd(async (event) => {
    seenTurns.push(event);
  });

  const output = { system: [] as string[] };
  await port.hooks["chat.message"]({ sessionID: "oc-1" }, {});
  await port.hooks["experimental.chat.system.transform"]({}, output);
  await port.hooks["experimental.text.complete"](
    { sessionID: "oc-1", messageID: "m1", partID: "p1" },
    { text: "done" },
  );

  assert.deepEqual(output.system, ["system:oc-1:please inspect files", "memory", "skill"]);
  assert.deepEqual(seenPromptEvents, [{ sessionId: "oc-1", query: "please inspect files" }]);
  assert.deepEqual(readOptions, { path: { id: "oc-1" }, query: { limit: 200 } });
  assert.deepEqual(seenTurns, [
    {
      sessionId: "oc-1",
      messages: canonicalMessagesFromOpenCodeSessionMessages(openCodeTranscript()),
    },
  ]);
});

test("createOpenCodeHarnessPort deduplicates repeated text completion hooks", async () => {
  const client: OpenCodeClientLike = {
    session: {
      async messages() {
        return openCodeTranscript();
      },
    },
  };
  const port = createOpenCodeHarnessPort(client, { model: fakeModel });
  let turns = 0;
  port.lifecycle.onTurnEnd(async () => {
    turns += 1;
  });

  await port.hooks["experimental.text.complete"](
    { sessionID: "oc-2", messageID: "m1", partID: "p1" },
    { text: "done" },
  );
  await port.hooks["experimental.text.complete"](
    { sessionID: "oc-2", messageID: "m1", partID: "p1" },
    { text: "done" },
  );

  assert.equal(turns, 1);
});

test("createOpenCodeHarnessPort includes completed assistant text before session transcript catches up", async () => {
  const client: OpenCodeClientLike = {
    session: {
      async messages() {
        return openCodeUserOnlyTranscript();
      },
    },
  };
  const port = createOpenCodeHarnessPort(client, { model: fakeModel });
  const seenTurns: unknown[] = [];
  port.lifecycle.onTurnEnd(async (event) => {
    seenTurns.push(event);
  });

  await port.hooks["experimental.text.complete"](
    { sessionID: "oc-3", messageID: "m1", partID: "p1" },
    { text: "noted" },
  );

  assert.deepEqual(seenTurns, [
    {
      sessionId: "oc-3",
      messages: [
        { role: "user", content: "remember apples" },
        { role: "assistant", content: "noted" },
      ],
    },
  ]);
});
