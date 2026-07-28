import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDreamAgentRunner,
  createExtractionAgentRunner,
  createMemFlywheel,
  runExtractionAgent,
} from "./index.js";
import {
  createAuditLogger,
  createFileTools,
  createMemoryFileToolContext,
  ExtractionResult,
  serializeMemoryFile,
  type StorageContext,
} from "@memflywheel/core";
import { scriptedBinding, stopTurn, toolTurn } from "./agent-test-support.test.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memflywheel-sdk-assembly-"));
}

function writeArgs(filePath: string, body: string) {
  return {
    filePath,
    content: serializeMemoryFile({
      type: filePath.split("/")[0] as "preference" | "ambient",
      name: path.basename(filePath, ".md"),
      body,
    }),
  };
}

test("Pi Agent Core preserves the native assistant/tool transcript across turns", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { resolveModel, contexts } = scriptedBinding([
      toolTurn("write", writeArgs("preference/preferred-drink.md", "The user prefers green tea.")),
      stopTurn,
    ]);
    const result = await runExtractionAgent({
      resolveModel,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({ ctx }),
      messages: [{ role: "user", text: "I prefer green tea." }],
      manifest: "(none)",
    });

    assert.equal(result.steps, 2);
    assert.deepEqual(result.toolCalls, [{ name: "write", ok: true }]);
    assert.match(
      await readFile(path.join(root, "preference/preferred-drink.md"), "utf8"),
      /green tea/,
    );
    assert.equal(contexts()[1]?.messages.at(-2)?.role, "assistant");
    assert.equal(contexts()[1]?.messages.at(-1)?.role, "toolResult");
    const assistant = contexts()[1]?.messages.at(-2);
    assert.equal(assistant?.role === "assistant" ? assistant.usage.totalTokens : undefined, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi Agent Core forwards the host credential on every tool-loop request", async () => {
  const root = await tempRoot();
  try {
    const { resolveModel, requestApiKeys } = scriptedBinding(
      [toolTurn("glob", { pattern: "**/*.md" }), stopTurn],
      { apiKey: "host-owned" },
    );

    await runExtractionAgent({
      resolveModel,
      tools: createFileTools(),
      toolCtx: createMemoryFileToolContext({
        ctx: { root, audit: createAuditLogger(root) },
      }),
      messages: [{ role: "user", text: "remember the stable preference" }],
      manifest: "(none)",
    });

    assert.deepEqual(requestApiKeys(), ["host-owned", "host-owned"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maxSteps fails the run instead of accepting a partial write-side pass", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { resolveModel } = scriptedBinding([
      toolTurn("glob", { pattern: "**/*.md" }, "c1"),
      toolTurn("glob", { pattern: "**/*.md" }, "c2"),
    ]);
    await assert.rejects(
      runExtractionAgent({
        resolveModel,
        tools: createFileTools(),
        toolCtx: createMemoryFileToolContext({ ctx }),
        messages: [{ role: "user", text: "x" }],
        manifest: "(none)",
        maxSteps: 2,
      }),
      /exceeded maxSteps \(2\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extraction runner writes memory and advances only after a complete Agent run", async () => {
  const root = await tempRoot();
  try {
    const { resolveModel } = scriptedBinding([
      toolTurn("write", writeArgs("preference/fruit.md", "The user likes strawberries.")),
      stopTurn,
    ]);
    const scribe = createMemFlywheel({
      root,
      agent: createExtractionAgentRunner({ resolveModel }),
    });
    await scribe.onSessionStart("s1");
    const result = await scribe.onTurnEnd("s1", [{ role: "user", text: "I love strawberries." }]);

    assert.equal(result.result, ExtractionResult.Completed);
    assert.match(await readFile(path.join(root, "preference/fruit.md"), "utf8"), /strawberries/);
    assert.match(await readFile(path.join(root, "MEMORY.md"), "utf8"), /fruit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dream uses the same Pi Agent Core runner", async () => {
  const root = await tempRoot();
  try {
    const ctx: StorageContext = { root, audit: createAuditLogger(root) };
    const { resolveModel, contexts } = scriptedBinding([
      toolTurn("write", writeArgs("ambient/team.md", "Mara leads backend.")),
      stopTurn,
    ]);
    const runner = createDreamAgentRunner({ resolveModel });
    const result = await runner({
      root,
      toolCtx: createMemoryFileToolContext({ ctx }),
      tools: createFileTools(),
      health: [],
      typeReview: [],
      manifest: "(none)",
      index: "# MEMORY",
    });

    assert.deepEqual(result.changed, ["ambient/team.md"]);
    assert.match(contexts()[0]?.systemPrompt ?? "", /consolidation engine/);
    assert.match(JSON.stringify(contexts()[0]?.messages[0]?.content), /Health findings/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
