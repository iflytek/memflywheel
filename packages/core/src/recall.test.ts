import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildContext,
  buildMemoryInstructionPrompt,
  buildMemoryIndexPrompt,
} from "./recall.js";
import { makeRoot, cleanup, writeFixture } from "./test-helpers.js";

test("buildMemoryInstructionPrompt is stable rules with no index", () => {
  const rules = buildMemoryInstructionPrompt();
  assert.ok(rules.includes("# 记忆"));
  assert.ok(rules.includes("召回规则"));
  assert.ok(!rules.includes("<system-reminder>"));
});

test("buildMemoryIndexPrompt wraps index in system-reminder", () => {
  const withIndex = buildMemoryIndexPrompt("- [a](p) - d");
  assert.ok(withIndex.startsWith("<system-reminder>"));
  assert.ok(withIndex.includes("## 可用记忆条目"));
  assert.ok(withIndex.includes("- [a](p) - d"));
  assert.ok(withIndex.endsWith("</system-reminder>"));

  const empty = buildMemoryIndexPrompt("");
  assert.ok(empty.includes("当前没有可用记忆条目"));
});

test("buildContext returns two segments and full index", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "u.md", { name: "用户称呼", description: "称呼", body: "叫小钟", mtime: 1 });
    const result = await buildContext({ root });
    assert.equal(result.enabled, true);
    assert.ok(result.systemPrompt.includes("# 记忆"));
    assert.ok(result.preludePrompt.startsWith("<system-reminder>"));
    assert.ok(result.preludePrompt.includes("用户称呼"));
  } finally {
    await cleanup(root);
  }
});

test("buildContext disabled returns empty and does not scan", async () => {
  const result = await buildContext({ root: "/tmp/whatever", enabled: false });
  assert.deepEqual(result, { systemPrompt: "", preludePrompt: "", enabled: false });
});
