import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hostMessagesFromOpenClawMessages,
  createOpenClawHarnessPort,
  registerOpenClawMemoryCapability,
  registerOpenClawSingleWriterGuard,
  openClawHostMemoryPaths,
  type OpenClawApiLike,
} from "./openclaw-port.js";
import {
  createOpenClawHostModel,
  type OpenClawNativeModelRuntime,
} from "./openclaw-native-model.js";
import { resolveTestModel, type TestModelCompletion } from "./model-test-support.test.js";

const fakeModel: TestModelCompletion = {
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

test("hostMessagesFromOpenClawMessages maps OpenAI-style tool calls", () => {
  const messages = hostMessagesFromOpenClawMessages([
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

test("hostMessagesFromOpenClawMessages maps OpenClaw native tool calls", () => {
  const messages = hostMessagesFromOpenClawMessages([
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
  const port = createOpenClawHarnessPort(api, { resolveModel: resolveTestModel(fakeModel) });
  const seenTurns: unknown[] = [];

  port.lifecycle.onPromptBuild(async (event) => ({
    systemPrompt: `system:${event.sessionId}:${event.query}`,
    preludePrompt: "memory\n\nskill",
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

test("createOpenClawHarnessPort keeps gateway agent_end work in its ordered background queue", async () => {
  const { api, typedHooks } = createFakeApi();
  const port = createOpenClawHarnessPort(api, { resolveModel: resolveTestModel(fakeModel) });
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
  assert.equal(hookReturned, true);
});

test("createOpenClawHarnessPort reports background lifecycle failures through the host logger", async () => {
  const { api, typedHooks } = createFakeApi();
  const errors: string[] = [];
  Object.assign(api, { logger: { error: (message: string) => errors.push(message) } });
  const port = createOpenClawHarnessPort(api, { resolveModel: resolveTestModel(fakeModel) });
  port.lifecycle.onTurnEnd(async () => {
    throw new Error("extraction failed");
  });

  const turnHook = typedHooks.get("agent_end");
  assert.ok(turnHook);
  await turnHook({ messages: [] }, { sessionKey: "agent:main:failure" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [
    "MemFlywheel OpenClaw background lifecycle failed: Error: extraction failed",
  ]);
});

test("createOpenClawHarnessPort falls back to legacy hook registration", () => {
  const { api, hooks } = createLegacyFakeApi();
  const port = createOpenClawHarnessPort(api, { resolveModel: resolveTestModel(fakeModel) });

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

test("OpenClaw single-writer guard blocks host writes inside memory and permits reads", async () => {
  const { api, typedHooks } = createFakeApi();
  registerOpenClawSingleWriterGuard(api, "/home/user/.openclaw/memflywheel", [
    "/home/user/.openclaw/workspace/MEMORY.md",
    "/home/user/.openclaw/workspace/memory",
  ]);
  const guard = typedHooks.get("before_tool_call");
  assert.ok(guard);

  assert.deepEqual(
    await guard({
      toolName: "write",
      params: { path: "/home/user/.openclaw/memflywheel/context/probe.md" },
    }),
    {
      block: true,
      blockReason:
        "MemFlywheel is single-writer: the host agent may read memory files, but only MemFlywheel memory agents may modify the memory repository.",
    },
  );
  assert.equal(
    await guard({
      toolName: "read",
      params: { path: "/home/user/.openclaw/memflywheel/context/probe.md" },
    }),
    undefined,
  );
  assert.equal(
    await guard({ toolName: "write", params: { path: "/home/user/project/output.md" } }),
    undefined,
  );
  assert.equal(
    (
      (await guard({
        toolName: "edit",
        params: { path: "/home/user/.openclaw/workspace/MEMORY.md" },
      })) as { block?: boolean }
    ).block,
    true,
  );
});

test("openClawHostMemoryPaths protects default and per-agent native memory stores", () => {
  assert.deepEqual(
    openClawHostMemoryPaths({
      agents: {
        defaults: { workspace: "/home/user/default" },
        list: [{ id: "ops", workspace: "/home/user/ops" }],
      },
    }),
    [
      "/home/user/default/MEMORY.md",
      "/home/user/default/memory",
      "/home/user/ops/MEMORY.md",
      "/home/user/ops/memory",
    ],
  );
});

test("createOpenClawHostModel uses one host-native structured completion", async () => {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const runtime: OpenClawNativeModelRuntime = {
    currentConfig() {
      return { agents: { defaults: { model: "deepseek/deepseek-chat" } } };
    },
    resolveDefaultAgentId() {
      return "main";
    },
    async prepareForAgent(input) {
      calls.push({ kind: "prepare", input });
      return {
        model: { api: "openai-completions", provider: "deepseek", id: "deepseek-chat" },
        auth: { mode: "api-key", apiKey: "host-owned" },
      };
    },
    async completePrepared(input) {
      calls.push({ kind: "complete", input });
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-2",
            name: "write",
            arguments: { path: "MEMORY.md", content: "tea" },
          },
        ],
        stopReason: "toolUse",
      };
    },
  };
  const resolveModel = createOpenClawHostModel(runtime, () => ({
    agentId: "work",
    modelRef: "deepseek/deepseek-chat",
  }));

  const binding = await resolveModel();
  const response = await (
    await binding.streamFn(
      binding.model,
      {
        systemPrompt: "Extract durable memory.",
        messages: [{ role: "user", content: "Remember tea.", timestamp: Date.now() }],
        tools: [],
      },
      {},
    )
  ).result();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    kind: "prepare",
    input: {
      cfg: { agents: { defaults: { model: "deepseek/deepseek-chat" } } },
      agentId: "work",
      modelRef: "deepseek/deepseek-chat",
    },
  });
  const context = (calls[1]?.input as { context: Record<string, unknown> }).context;
  assert.equal(context.systemPrompt, "Extract durable memory.");
  assert.equal((context.messages as unknown[]).length, 1);
  assert.deepEqual(context.tools, []);
  assert.ok(response.content.some((part) => part.type === "toolCall" && part.name === "write"));
});

test("createOpenClawHostModel rejects non-terminal native completions", async () => {
  const runtime: OpenClawNativeModelRuntime = {
    currentConfig: () => ({}),
    resolveDefaultAgentId: () => "main",
    prepareForAgent: async () => ({ model: {}, auth: {} }),
    completePrepared: async () => ({ role: "assistant", content: [], stopReason: "pending" }),
  };
  const binding = await createOpenClawHostModel(runtime, () => ({}))();

  await assert.rejects(
    Promise.resolve(
      binding.streamFn(
        binding.model,
        { systemPrompt: "Extract memory.", messages: [], tools: [] },
        {},
      ),
    ),
    /before reaching a terminal state/,
  );
});

test("createOpenClawHarnessPort fails without the host native model runtime", () => {
  assert.throws(
    () => createOpenClawHarnessPort(createFakeApi().api),
    /requires OpenClaw's native structured model runtime/,
  );
});
