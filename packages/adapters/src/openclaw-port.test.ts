import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalMessagesFromOpenClawMessages,
  createOpenClawHarnessPort,
  registerOpenClawMemoryCapability,
  type OpenClawApiLike,
} from "./openclaw-port.js";
import type { CanonicalModelCompletion } from "@memflywheel/model";

const fakeModel: CanonicalModelCompletion = {
  async complete() {
    return { message: { role: "assistant", content: "done" } };
  },
};

function createFakeApi() {
  const typedHooks = new Map<
    string,
    (event: unknown, context?: unknown) => Promise<unknown> | unknown
  >();
  const legacyHooks = new Map<
    string,
    (event: unknown, context?: unknown) => Promise<unknown> | unknown
  >();
  const capabilities: unknown[] = [];
  const api: OpenClawApiLike = {
    on(event, handler) {
      typedHooks.set(event, handler);
    },
    registerHook(events, handler) {
      for (const event of Array.isArray(events) ? events : [events])
        legacyHooks.set(event, handler);
    },
    registerMemoryCapability(capability) {
      capabilities.push(capability);
    },
  };
  return { api, typedHooks, legacyHooks, capabilities };
}

function createLegacyFakeApi() {
  const hooks = new Map<
    string,
    (event: unknown, context?: unknown) => Promise<unknown> | unknown
  >();
  const api: OpenClawApiLike = {
    registerHook(events, handler) {
      for (const event of Array.isArray(events) ? events : [events]) hooks.set(event, handler);
    },
  };
  return { api, hooks };
}

test("canonicalMessagesFromOpenClawMessages maps OpenAI-style tool calls", () => {
  const messages = canonicalMessagesFromOpenClawMessages([
    { role: "user", content: "inspect repo" },
    {
      role: "assistant",
      content: "reading",
      tool_calls: [
        {
          id: "call-1",
          function: { name: "read_file", arguments: '{"path":"package.json"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "package" },
  ]);

  assert.deepEqual(messages, [
    { role: "user", content: "inspect repo" },
    {
      role: "assistant",
      content: "reading",
      toolCalls: [{ id: "call-1", name: "read_file", input: { path: "package.json" } }],
    },
    { role: "tool", toolCallId: "call-1", content: "package" },
  ]);
});

test("canonicalMessagesFromOpenClawMessages maps OpenClaw native tool calls", () => {
  const messages = canonicalMessagesFromOpenClawMessages([
    { role: "user", content: [{ type: "text", text: "inspect repo" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read a file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "package" }],
    },
  ]);

  assert.deepEqual(messages, [
    { role: "user", content: "inspect repo" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "read", input: { path: "package.json" } }],
    },
    { role: "tool", toolCallId: "call-1", content: "package" },
  ]);
});

test("createOpenClawHarnessPort registers prompt and turn hooks", async () => {
  const { api, typedHooks, legacyHooks } = createFakeApi();
  const port = createOpenClawHarnessPort(api, { model: fakeModel });
  const seenTurns: unknown[] = [];

  port.lifecycle.onPromptBuild(async (event) => ({
    systemPrompt: `system:${event.sessionId}:${event.query}`,
    preludePrompt: "memory",
    skillPreludePrompt: "skill",
  }));
  port.lifecycle.onTurnEnd(async (event) => {
    seenTurns.push(event);
  });

  const promptHook = typedHooks.get("before_prompt_build");
  const turnHook = typedHooks.get("agent_end");
  assert.ok(promptHook);
  assert.ok(turnHook);
  assert.equal(legacyHooks.size, 0);

  const promptResult = await promptHook(
    { prompt: "hello" },
    { sessionKey: "agent:main:session:1" },
  );
  await turnHook(
    {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    },
    { sessionKey: "agent:main:session:1" },
  );

  assert.deepEqual(promptResult, {
    prependSystemContext: "system:agent:main:session:1:hello",
    prependContext: "memory\n\nskill",
  });
  assert.deepEqual(seenTurns, [
    {
      sessionId: "agent:main:session:1",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    },
  ]);
});

test("createOpenClawHarnessPort runs agent_end work after the hook returns", async () => {
  const { api, typedHooks } = createFakeApi();
  const port = createOpenClawHarnessPort(api, { model: fakeModel });
  const releases: (() => void)[] = [];
  let started = 0;
  let finished = 0;

  port.lifecycle.onTurnEnd(async () => {
    started += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    finished += 1;
  });

  const turnHook = typedHooks.get("agent_end");
  assert.ok(turnHook);
  const hookRun = Promise.resolve(
    turnHook(
      {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      },
      { sessionKey: "agent:main:session:1" },
    ),
  );

  await new Promise<void>((resolve) => setImmediate(resolve));

  let hookReturned = false;
  hookRun.then(() => {
    hookReturned = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(started, 1);
  assert.equal(finished, 0);
  assert.equal(hookReturned, true);

  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(finished, 1);
});

test("createOpenClawHarnessPort falls back to legacy hook registration", () => {
  const { api, hooks } = createLegacyFakeApi();
  const port = createOpenClawHarnessPort(api, { model: fakeModel });

  port.lifecycle.onSessionEnd(async () => undefined);

  assert.ok(hooks.get("session_end"));
  assert.ok(hooks.get("gateway_stop"));
});

test("registerOpenClawMemoryCapability marks MemFlywheel as a memory capability", () => {
  const { api, capabilities } = createFakeApi();
  registerOpenClawMemoryCapability(api);

  assert.equal(capabilities.length, 1);
  assert.deepEqual((capabilities[0] as { promptBuilder: () => string[] }).promptBuilder(), [
    "MemFlywheel long-term memory is active.",
  ]);
});
