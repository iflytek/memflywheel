import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DREAM_SYSTEM_PROMPT, buildDreamAgentUserMessage } from "./dream-prompt.js";

test("default dream prompt is a tool-use contract: lists the tools, demands read-before-merge, and is name-free", () => {
  const p = DEFAULT_DREAM_SYSTEM_PROMPT;
  for (const tool of [
    "memory_list",
    "memory_search",
    "memory_read",
    "memory_save",
    "memory_update",
    "memory_archive",
  ]) {
    assert.ok(p.includes(tool), `prompt mentions ${tool}`);
  }
  // The soul of the change: never author a merged/compressed body from an excerpt.
  assert.match(p, /read full bodies|memory_read each file|full body/i);
  assert.match(p, /merge/i);
  assert.match(p, /compress-memory/);
  // No JSON op format anymore — the tool calls ARE the changes.
  assert.ok(!/fenced json|JSON array of ops/i.test(p), "no leftover JSON-op instructions");
  assert.ok(!new RegExp(["loo", "my"].join(""), "i").test(p), "prompt is name-free");
});

test("buildDreamAgentUserMessage renders all packets and optional coordination", () => {
  const out = buildDreamAgentUserMessage({
    index: "MEMORY",
    manifest: "preference/x.md",
    health: [{ severity: "error", code: "path-type-mismatch", paths: ["a/b.md"], message: "m" }],
    typeReview: [{ path: "a/b.md", type: "context", name: "B", description: "d", excerpt: "ex" }],
    coordination: { reason: "why", memoryAction: "compress-memory", topics: ["t1"] },
  });
  assert.ok(out.includes("path-type-mismatch"));
  assert.ok(out.includes("a/b.md (type=context"));
  assert.ok(out.includes("memoryAction: compress-memory"));
  // Reinforces read-before-edit in the seed message itself.
  assert.match(out, /memory_read the full body/i);
});

test("buildDreamAgentUserMessage omits coordination block when absent", () => {
  const out = buildDreamAgentUserMessage({ index: "", manifest: "", health: [], typeReview: [] });
  assert.ok(!out.includes("Coordination directive"));
  assert.ok(out.includes("(none)"));
});
