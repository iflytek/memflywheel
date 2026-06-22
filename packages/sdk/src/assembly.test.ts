import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMemScribe,
  createDreamAgentRunner,
  runExtractionAgent,
  createExtractionAgentRunner,
  MAX_EXTRACTION_STEPS,
  createFileTools,
  ExtractionResult,
} from "./index.js";
import {
  createAuditLogger,
  createMemoryFileToolContext,
  serializeMemoryFile,
  type MemoryType,
  type StorageContext,
} from "@memscribe/core";
import type {
  CanonicalModelCompletion,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "@memscribe/model";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memscribe-sdk-assembly-"));
}

/**
 * A scripted canonical model: returns each queued response in turn, recording the
 * requests it received (so multi-turn re-feed can be asserted).
 */
function scriptedModel(responses: CanonicalModelResponse[]): {
  model: CanonicalModelCompletion;
  requests: () => CanonicalModelRequest[];
} {
  const seen: CanonicalModelRequest[] = [];
  let i = 0;
  const model: CanonicalModelCompletion = {
    complete: async (req) => {
      seen.push(req);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
  return { model, requests: () => seen };
}

function toolCallResponse(name: string, args: unknown, id = "c1"): CanonicalModelResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [{ id, name, input: args }],
    },
    finishReason: "tool-calls",
  };
}

const STOP_RESPONSE: CanonicalModelResponse = {
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
};

function slug(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-+|-+$/g, "") || "memory"}.md`;
}

function writeMemoryArgs(input: {
  type: MemoryType;
  name: string;
  description?: string;
  body: string;
  filename?: string;
}) {
  return {
    filePath: `${input.type}/${input.filename ?? slug(input.name)}`,
    content: serializeMemoryFile(input),
  };
}

// ---- runExtractionAgent: the tool-calling loop drives core's file tools. ----

test("runExtractionAgent: subagent calls write then stops; file is written", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { model, requests } = scriptedModel([
      toolCallResponse("write", writeMemoryArgs({
        type: "preference",
        name: "Preferred drink",
        description: "go-to beverage",
        body: "The user prefers green tea over coffee.",
      })),
      STOP_RESPONSE,
    ]);

    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
      messages: [{ role: "user", text: "I always drink green tea, not coffee." }],
      manifest: "(none)",
    });

    assert.equal(result.steps, 2);
    assert.equal(result.stoppedReason, "no-tool-calls");
    assert.deepEqual(result.toolCalls, [{ name: "write", ok: true }]);
    assert.equal(result.changed.length, 1);

    // The subagent wrote the file directly via the tool handler.
    const file = await readFile(path.join(root, "preference", "preferred-drink.md"), "utf8");
    assert.match(file, /green tea/);

    // Multi-turn re-feed: the second request carries the assistant tool-calls turn
    // plus a role:"tool" result message.
    const reqs = requests();
    assert.equal(reqs.length, 2);
    const second = reqs[1].messages;
    const toolMsg = second.find((m) => m.role === "tool");
    assert.ok(toolMsg, "a role:tool result was fed back");
    assert.equal(toolMsg?.toolCallId, "c1");
    assert.match(String(toolMsg?.content), /preference\/preferred-drink\.md/);
    // And the assistant tool-calls turn was preserved in history.
    assert.ok(second.some((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExtractionAgent: subagent calls glob first, then write", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { model } = scriptedModel([
      toolCallResponse("glob", { pattern: "**/*.md" }, "l1"),
      toolCallResponse(
        "write",
        writeMemoryArgs({ type: "identity", name: "Address as", body: "Call the user Dr. Mara." }),
        "s1",
      ),
      STOP_RESPONSE,
    ]);

    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
      messages: [{ role: "user", text: "Address me as Dr. Mara." }],
      manifest: "(none)",
    });

    assert.equal(result.steps, 3);
    assert.deepEqual(
      result.toolCalls.map((c) => c.name),
      ["glob", "write"],
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
    const model: CanonicalModelCompletion = {
      complete: async () => toolCallResponse("glob", { pattern: "**/*.md" }, `c${Math.random()}`),
    };

    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
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
    const model: CanonicalModelCompletion = {
      complete: async () => toolCallResponse("glob", { pattern: "**/*.md" }, `c${(n += 1)}`),
    };
    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
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
    const model: CanonicalModelCompletion = {
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error("MemScribe model completion: request failed (429). rate limited");
        return STOP_RESPONSE;
      },
    };
    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
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
    const model: CanonicalModelCompletion = {
      complete: async () => {
        calls += 1;
        throw new Error("MemScribe model completion: request failed (401). invalid api key");
      },
    };
    await assert.rejects(
      runExtractionAgent({
        model,
        tools: createFileTools(),
        toolCtx: createMemoryFileToolContext({ ctx }),
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
    const model: CanonicalModelCompletion = {
      complete: async () => {
        called = true;
        return STOP_RESPONSE;
      },
    };
    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
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
    const { model } = scriptedModel([STOP_RESPONSE]);
    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
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

test("runExtractionAgent: unknown canonical tool calls are reported, not thrown", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { model } = scriptedModel([toolCallResponse("missing_file_tool", { pattern: "**/*.md" }, "c1"), STOP_RESPONSE]);
    const result = await runExtractionAgent({
      model,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
      messages: [{ role: "user", text: "x" }],
      manifest: "(none)",
    });
    assert.deepEqual(result.toolCalls, [{ name: "missing_file_tool", ok: false }]);
    assert.deepEqual(result.changed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- createExtractionAgentRunner + scribe: end-to-end turn-end write. ----

test("createExtractionAgentRunner: turn-end writes a memory via the agent loop", async () => {
  const root = await tempRoot();
  try {
    const { model } = scriptedModel([
      toolCallResponse("write", writeMemoryArgs({
        type: "preference",
        name: "fruit",
        body: "The user likes strawberries.",
      })),
      STOP_RESPONSE,
    ]);
    const scribe = createMemScribe({ root, agent: createExtractionAgentRunner({ model }) });
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

// ---- createDreamAgentRunner: dream is the same tool-calling loop, seeded for consolidation. ----

test("createDreamAgentRunner: drives the dream subagent over ordinary file tools with the consolidation prompt + packets", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { model, requests } = scriptedModel([
      toolCallResponse(
        "write",
        writeMemoryArgs({ type: "ambient", name: "Team", description: "team roles", body: "Mara leads backend." }),
        "d1",
      ),
      STOP_RESPONSE,
    ]);

    const runner = createDreamAgentRunner({ model });
    const result = await runner({
      root,
      toolCtx: createMemoryFileToolContext({ ctx }),
      tools: createFileTools(),
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
