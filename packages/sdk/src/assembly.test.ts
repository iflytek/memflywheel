import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMemScribe,
  createDreamAgentRunner,
  createToolCompletion,
  runExtractionAgent,
  createExtractionAgentRunner,
  MAX_EXTRACTION_STEPS,
  defaultExtractionAgentFromEnv,
  defaultDreamRunnerFromEnv,
  createMemoryTools,
  ExtractionResult,
  type ToolCompletion,
  type ToolCompletionRequest,
  type ToolCompletionResponse,
} from "./index.js";
import { createAuditLogger, type StorageContext } from "@memscribe/core";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memscribe-sdk-assembly-"));
}

/**
 * A scripted ToolCompletion: returns each queued response in turn, recording the
 * requests it received (so multi-turn re-feed can be asserted).
 */
function scriptedToolCompletion(responses: ToolCompletionResponse[]): {
  fn: ToolCompletion;
  requests: () => ToolCompletionRequest[];
} {
  const seen: ToolCompletionRequest[] = [];
  let i = 0;
  const fn: ToolCompletion = async (req) => {
    seen.push(req);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
  return { fn, requests: () => seen };
}

function toolCallResponse(name: string, args: unknown, id = "c1"): ToolCompletionResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls",
  };
}

const STOP_RESPONSE: ToolCompletionResponse = {
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
};

// ---- runExtractionAgent: the tool-calling loop drives core's memory tools. ----

test("runExtractionAgent: subagent calls memory_save then stops; file is written", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { fn, requests } = scriptedToolCompletion([
      toolCallResponse("memory_save", {
        type: "preference",
        name: "Preferred drink",
        description: "go-to beverage",
        body: "The user prefers green tea over coffee.",
      }),
      STOP_RESPONSE,
    ]);

    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "I always drink green tea, not coffee." }],
      manifest: "(none)",
    });

    assert.equal(result.steps, 2);
    assert.equal(result.stoppedReason, "no-tool-calls");
    assert.deepEqual(result.toolCalls, [{ name: "memory_save", ok: true }]);
    assert.equal(result.changed.length, 1);

    // The subagent wrote the file directly via the tool handler.
    const file = await readFile(path.join(root, "preference", "preferred-drink.md"), "utf8");
    assert.match(file, /green tea/);

    // Multi-turn re-feed: the second request carries the assistant tool_calls turn
    // plus a role:"tool" result message.
    const reqs = requests();
    assert.equal(reqs.length, 2);
    const second = reqs[1].messages;
    const toolMsg = second.find((m) => m.role === "tool");
    assert.ok(toolMsg, "a role:tool result was fed back");
    assert.equal(toolMsg?.tool_call_id, "c1");
    assert.match(String(toolMsg?.content), /saved preference\/preferred-drink\.md/);
    // And the assistant tool_calls turn was preserved in history.
    assert.ok(second.some((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: subagent calls memory_list first, then memory_save", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { fn } = scriptedToolCompletion([
      toolCallResponse("memory_list", {}, "l1"),
      toolCallResponse(
        "memory_save",
        { type: "identity", name: "Address as", body: "Call the user Dr. Mara." },
        "s1",
      ),
      STOP_RESPONSE,
    ]);

    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "Address me as Dr. Mara." }],
      manifest: "(none)",
    });

    assert.equal(result.steps, 3);
    assert.deepEqual(
      result.toolCalls.map((c) => c.name),
      ["memory_list", "memory_save"],
    );
    const file = await readFile(path.join(root, "identity", "address-as.md"), "utf8");
    assert.match(file, /Dr\. Mara/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: maxSteps caps the loop when the model keeps calling tools", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    // Always returns a tool call ⇒ loop only stops on maxSteps.
    const fn: ToolCompletion = async () =>
      toolCallResponse("memory_list", {}, `c${Math.random()}`);

    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "x" }],
      manifest: "(none)",
      maxSteps: 3,
    });
    assert.equal(result.steps, 3);
    assert.equal(result.stoppedReason, "max-steps");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: hard cap clamps a runaway loop to MAX_EXTRACTION_STEPS (20)", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    let n = 0;
    const fn: ToolCompletion = async () => toolCallResponse("memory_list", {}, `c${(n += 1)}`);
    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "x" }],
      manifest: "(none)",
      maxSteps: 100, // requested above the hard cap
    });
    assert.equal(MAX_EXTRACTION_STEPS, 20);
    assert.equal(result.steps, 20); // clamped — never runs away
    assert.equal(result.stoppedReason, "max-steps");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: retries a transient error (429) then succeeds", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    let calls = 0;
    const fn: ToolCompletion = async () => {
      calls += 1;
      if (calls === 1) throw new Error("MemScribe tool completion: request failed (429). rate limited");
      return STOP_RESPONSE;
    };
    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "x" }],
      manifest: "(none)",
    });
    assert.equal(calls, 2); // first threw (retryable), retried and succeeded
    assert.equal(result.stoppedReason, "no-tool-calls");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: a non-retryable error (401) propagates without retry", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    let calls = 0;
    const fn: ToolCompletion = async () => {
      calls += 1;
      throw new Error("MemScribe tool completion: request failed (401). invalid api key");
    };
    await assert.rejects(
      runExtractionAgent({
        toolCompletion: fn,
        tools: createMemoryTools(),
        toolCtx: { ctx },
        messages: [{ role: "user", text: "x" }],
        manifest: "(none)",
      }),
      /401/,
    );
    assert.equal(calls, 1); // auth error is not retried
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: an aborted signal stops the loop gracefully", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const fn: ToolCompletion = async () => {
      called = true;
      return STOP_RESPONSE;
    };
    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "x" }],
      manifest: "(none)",
      signal: ac.signal,
    });
    assert.equal(result.stoppedReason, "aborted");
    assert.equal(result.steps, 0);
    assert.equal(called, false); // no model call after abort
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: no tool call on the first turn ⇒ immediate decline, no writes", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { fn } = scriptedToolCompletion([STOP_RESPONSE]);
    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "what time is it?" }],
      manifest: "(none)",
    });
    assert.equal(result.steps, 1);
    assert.equal(result.stoppedReason, "no-tool-calls");
    assert.deepEqual(result.changed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: invalid tool args are reported, not thrown", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { fn } = scriptedToolCompletion([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "memory_save", arguments: "{not json" } }],
        },
        finishReason: "tool_calls",
      },
      STOP_RESPONSE,
    ]);
    const result = await runExtractionAgent({
      toolCompletion: fn,
      tools: createMemoryTools(),
      toolCtx: { ctx },
      messages: [{ role: "user", text: "x" }],
      manifest: "(none)",
    });
    assert.deepEqual(result.toolCalls, [{ name: "memory_save", ok: false }]);
    assert.deepEqual(result.changed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- createExtractionAgentRunner + scribe: end-to-end turn-end write. ----

test("createExtractionAgentRunner: turn-end writes a memory via the agent loop", async () => {
  const root = await tempRoot();
  try {
    const { fn } = scriptedToolCompletion([
      toolCallResponse("memory_save", {
        type: "preference",
        name: "fruit",
        body: "The user likes strawberries.",
      }),
      STOP_RESPONSE,
    ]);
    const scribe = createMemScribe({ root, agent: createExtractionAgentRunner({ toolCompletion: fn }) });
    await scribe.onSessionStart("s1");

    const turn = await scribe.onTurnEnd("s1", [{ role: "user", text: "I love strawberries, remember that." }]);
    assert.equal(turn.skipped, false);
    assert.equal(turn.result, ExtractionResult.Completed);

    const file = await readFile(path.join(root, "preference", "fruit.md"), "utf8");
    assert.match(file, /likes strawberries/);
    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.match(index, /fruit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- createToolCompletion: OpenAI /chat/completions tools request + parsing. ----

function captureFetch(responseJson: unknown): {
  impl: typeof fetch;
  last: () => { url: string; init: RequestInit } | undefined;
} {
  let captured: { url: string; init: RequestInit } | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return {
      ok: true,
      status: 200,
      async json() {
        return responseJson;
      },
      async text() {
        return "";
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, last: () => captured };
}

test("createToolCompletion: builds /chat/completions with a tools array and parses tool_calls", async () => {
  const { impl, last } = captureFetch({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "abc",
              type: "function",
              function: { name: "memory_save", arguments: '{"type":"preference","name":"x","body":"y"}' },
            },
          ],
        },
      },
    ],
  });
  const complete = createToolCompletion({
    apiKey: "sk" + "-test",
    model: "gpt-test",
    endpoint: "https://example.test/v1",
    fetchImpl: impl,
  });

  const resp = await complete({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "memory_save",
          description: "save",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      },
    ],
  });

  assert.equal(resp.finishReason, "tool_calls");
  assert.equal(resp.message.tool_calls?.length, 1);
  assert.equal(resp.message.tool_calls?.[0].id, "abc");
  assert.equal(resp.message.tool_calls?.[0].function.name, "memory_save");

  const req = last()!;
  assert.equal(req.url, "https://example.test/v1/chat/completions");
  const headers = req.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer " + "sk" + "-test");
  const body = JSON.parse(String(req.init.body));
  assert.equal(body.model, "gpt-test");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, "memory_save");
});

test("createToolCompletion: serializes assistant tool_calls and role:tool messages for re-feed", async () => {
  const { impl, last } = captureFetch({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  });
  const complete = createToolCompletion({ apiKey: "sk", endpoint: "https://x.test/v1", fetchImpl: impl });
  await complete({
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "memory_list", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "(no existing memories)" },
    ],
    tools: [],
  });
  const body = JSON.parse(String(last()!.init.body));
  assert.equal(body.messages[0].tool_calls[0].id, "c1");
  assert.equal(body.messages[0].content, null);
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "c1");
});

test("createToolCompletion: non-2xx throws", async () => {
  const impl = (async () =>
    ({
      ok: false,
      status: 429,
      async text() {
        return "rate limited";
      },
      async json() {
        return {};
      },
    }) as unknown as Response) as unknown as typeof fetch;
  const complete = createToolCompletion({ apiKey: "sk", fetchImpl: impl });
  await assert.rejects(complete({ messages: [], tools: [] }), /failed \(429\)/);
});

test("createToolCompletion: missing key throws only at call time", async () => {
  const saved = { a: process.env.MEMSCRIBE_LLM_API_KEY, b: process.env.OPENAI_API_KEY };
  delete process.env.MEMSCRIBE_LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const complete = createToolCompletion({}); // no throw at construction
    await assert.rejects(complete({ messages: [], tools: [] }), /no API key/);
    assert.equal(defaultExtractionAgentFromEnv(), undefined);
  } finally {
    if (saved.a !== undefined) process.env.MEMSCRIBE_LLM_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.OPENAI_API_KEY = saved.b;
  }
});

test("defaultExtractionAgentFromEnv: returns an agent when a key is present", () => {
  const agent = defaultExtractionAgentFromEnv({ apiKey: "sk" + "-explicit" });
  assert.equal(typeof agent, "function");
});

// ---- createDreamAgentRunner: dream is the same tool-calling loop, seeded for consolidation. ----

test("createDreamAgentRunner: drives the dream subagent over the memory tools with the consolidation prompt + packets", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { fn, requests } = scriptedToolCompletion([
      toolCallResponse(
        "memory_save",
        { type: "ambient", name: "Team", description: "team roles", body: "Mara leads backend." },
        "d1",
      ),
      STOP_RESPONSE,
    ]);

    const runner = createDreamAgentRunner({ toolCompletion: fn });
    const result = await runner({
      root,
      toolCtx: { ctx },
      tools: createMemoryTools(),
      health: [{ severity: "warn", code: "duplicate-content", paths: ["ambient/a.md"], message: "dup" }],
      typeReview: [{ path: "ambient/a.md", type: "ambient", name: "a", description: "d", excerpt: "x" }],
      manifest: "ambient/a.md",
      index: "# MEMORY",
      coordination: { reason: "idle", memoryAction: "consolidate", topics: ["team"] },
    });

    // The subagent wrote directly via the tool handler.
    assert.ok(result.changed.includes("ambient/team.md"));
    const file = await readFile(path.join(root, "ambient", "team.md"), "utf8");
    assert.match(file, /Mara leads backend/);

    // The loop was seeded with the dream consolidation system prompt + packets.
    const reqs = requests();
    assert.match(String(reqs[0].messages[0].content), /consolidation engine/);
    assert.match(String(reqs[0].messages[1].content), /Health findings/);
    assert.match(String(reqs[0].messages[1].content), /Type review/);
    assert.match(String(reqs[0].messages[1].content), /memoryAction: consolidate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaultDreamRunnerFromEnv: returns a runner with a key, undefined without", () => {
  assert.equal(typeof defaultDreamRunnerFromEnv({ apiKey: "sk" + "-explicit" }), "function");

  const saved = { a: process.env.MEMSCRIBE_LLM_API_KEY, b: process.env.OPENAI_API_KEY };
  delete process.env.MEMSCRIBE_LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(defaultDreamRunnerFromEnv(), undefined);
  } finally {
    if (saved.a !== undefined) process.env.MEMSCRIBE_LLM_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.OPENAI_API_KEY = saved.b;
  }
});
