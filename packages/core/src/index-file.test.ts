import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildIndexContent,
  truncateIndex,
  applyAgingHints,
  syncMemoryIndex,
  readMemoryIndex,
  AGING_THRESHOLDS,
  INDEX_MAX_LINES,
  INDEX_MAX_BYTES,
} from "./index-file.js";
import { type MemoryEntry } from "./types.js";
import { makeRoot, cleanup, writeFixture } from "./test-helpers.js";

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    filename: "u.md",
    relativePath: "identity/u.md",
    name: "Name",
    description: "Desc",
    type: "identity",
    mtime: Date.now(),
    ...over,
  };
}

test("buildIndexContent formats the index line", () => {
  const out = buildIndexContent([entry({})]);
  assert.equal(
    out,
    `- [Name](identity/u.md) - Desc (type: identity, path: identity/u.md)`,
  );
});

test("buildIndexContent uses （无描述） placeholder", () => {
  const out = buildIndexContent([entry({ description: "" })]);
  assert.ok(out.includes(" - （无描述） "));
});

test("buildIndexContent includes retrieval terms in the derived index metadata", () => {
  const out = buildIndexContent([
    entry({
      description: "Caroline plans to adopt as a single parent",
      retrievalTerms: ["relationship status", "single", "single parent", "adoption"],
    }),
  ]);

  assert.equal(
    out,
    "- [Name](identity/u.md) - Caroline plans to adopt as a single parent (type: identity, path: identity/u.md, terms: relationship status; single; single parent; adoption)",
  );
});

test("truncateIndex caps lines and appends marker", () => {
  const many = Array.from({ length: INDEX_MAX_LINES + 50 }, (_, i) => `- line ${i}`).join("\n");
  const out = truncateIndex(many);
  const lines = out.split("\n");
  assert.ok(out.includes("记忆索引已截断"));
  // 200 content lines + blank + marker.
  assert.equal(lines.filter((l) => l.startsWith("- line ")).length, INDEX_MAX_LINES);
});

test("truncateIndex caps bytes", () => {
  const big = Array.from({ length: 300 }, () => "- " + "字".repeat(200)).join("\n");
  const out = truncateIndex(big);
  // Drop the marker for the byte check; the content portion must be within budget.
  const content = out.replace(/\n\n<!--[\s\S]*-->$/, "");
  assert.ok(Buffer.byteLength(content, "utf8") <= INDEX_MAX_BYTES);
});

test("applyAgingHints only ages context/ambient past threshold", () => {
  assert.equal(AGING_THRESHOLDS.identity, null);
  assert.ok(typeof AGING_THRESHOLDS.context === "number");

  const oldMtime = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const entries = [
    entry({ type: "context", relativePath: "context/c.md", filename: "c.md", mtime: oldMtime }),
    entry({ type: "identity", relativePath: "identity/i.md", filename: "i.md", mtime: oldMtime }),
  ];
  const content = buildIndexContent(entries);
  const hinted = applyAgingHints(content, entries);
  const ctxLine = hinted.split("\n").find((l) => l.includes("context/c.md"))!;
  const idLine = hinted.split("\n").find((l) => l.includes("identity/i.md"))!;
  assert.ok(ctxLine.includes("天未更新，使用前建议验证"));
  assert.ok(!idLine.includes("天未更新"));
});

test("syncMemoryIndex writes MEMORY.md and readMemoryIndex reads it", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "u.md", { name: "N", description: "D", body: "b", mtime: 1 });
    const content = await syncMemoryIndex(root);
    assert.ok(content.includes("- [N]("));
    const onDisk = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.equal(onDisk, content);
    assert.equal(await readMemoryIndex(root), content);
  } finally {
    await cleanup(root);
  }
});

test("readMemoryIndex returns empty for missing file", async () => {
  assert.equal(await readMemoryIndex("/tmp/missing-memscribe-root-xyz"), "");
});
