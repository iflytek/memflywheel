import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionAgentUserMessage,
} from "./extract-prompt.js";

test("default prompt covers the spec surface, tool contract, and is name-free", () => {
  const p = DEFAULT_EXTRACTION_SYSTEM_PROMPT;
  for (const type of ["identity", "preference", "style", "workflow", "context", "ambient"]) {
    assert.ok(p.includes(type), `prompt mentions ${type}`);
  }
  for (const tool of ["glob", "grep", "read", "write", "edit", "bash"]) {
    assert.ok(p.includes(tool), `prompt mentions ${tool}`);
  }
  assert.doesNotMatch(p, /memory_(list|search|read|save|update|archive)/);
  assert.ok(/read before you update/i.test(p), "prompt has the read-before-update rule");
  assert.ok(/retrieval_terms/i.test(p), "prompt requires retrieval routing terms");
  assert.ok(/without embedding the full body/i.test(p), "prompt keeps body out of embedding");
  assert.ok(/never use absolute paths/i.test(p), "prompt forbids absolute paths");
  assert.ok(/never prefix paths with memory\//i.test(p), "prompt forbids memory/ prefix");
  assert.ok(/never use event\//i.test(p), "prompt forbids invented event type");
  assert.ok(/high-risk/i.test(p));
  assert.ok(!/```json/.test(p), "prompt no longer asks for a JSON array");
  assert.ok(!new RegExp(["loo", "my"].join(""), "i").test(p), "prompt is name-free");
});

test("buildExtractionAgentUserMessage renders manifest and labelled turns", () => {
  const out = buildExtractionAgentUserMessage({
    messages: [
      { role: "user", text: "I prefer tea." },
      { role: "assistant", text: "Noted." },
    ],
    manifest: "preference/x.md",
  });
  assert.ok(out.includes("preference/x.md"));
  assert.ok(out.includes("User: I prefer tea."));
  assert.ok(out.includes("Assistant: Noted."));
  assert.ok(out.includes("Use the ordinary file tools"));
});

test("buildExtractionAgentUserMessage renders the timestamp anchor in the speaker label", () => {
  const out = buildExtractionAgentUserMessage({
    messages: [
      { role: "user", text: "I went to the support group yesterday", timestamp: "2023-05-08" },
      { role: "assistant", text: "Noted." },
    ],
    manifest: "",
  });
  assert.ok(out.includes("User [2023-05-08]: I went to the support group yesterday"));
  assert.ok(out.includes("Assistant: Noted."));
});

test("buildExtractionAgentUserMessage falls back to (none) for empty manifest", () => {
  const out = buildExtractionAgentUserMessage({ messages: [], manifest: "" });
  assert.ok(out.includes("(none)"));
});

test("folds tool calls into text with per-field truncation (input head, output head+tail)", () => {
  const bigOut = "HEAD_" + "x".repeat(5000) + "_TAIL";
  const out = buildExtractionAgentUserMessage({
    manifest: "",
    messages: [
      { role: "user", text: "装依赖跑测试" },
      {
        role: "assistant",
        text: "好的",
        toolCalls: [{ name: "Bash", input: { command: "pnpm install" }, output: bigOut }],
      },
    ],
  });
  assert.ok(out.includes("Tool(Bash):"), "renders Tool line");
  assert.ok(out.includes("pnpm install"), "input visible");
  assert.ok(out.includes("Output:"), "renders Output line");
  assert.ok(/HEAD_x+/.test(out), "output keeps head");
  assert.ok(out.includes("_TAIL"), "output keeps tail (head+tail truncation)");
  assert.ok(out.includes("omitted"), "output shows an elision marker");
  // The folded output must be far smaller than the 5k raw output.
  const outputLine = out.split("\n").find((l) => l.startsWith("Output:"))!;
  assert.ok(outputLine.length < 600, `output line bounded (~500), got ${outputLine.length}`);
});

test("foldToolCalls:false suppresses folding", () => {
  const out = buildExtractionAgentUserMessage({
    manifest: "",
    foldToolCalls: false,
    messages: [{ role: "assistant", text: "hi", toolCalls: [{ name: "Bash", input: "ls" }] }],
  });
  assert.ok(!out.includes("Tool(Bash)"), "no tool lines when disabled");
});

test("window-level cap omits overflow tool calls with a note", () => {
  const calls = Array.from({ length: 60 }, (_, i) => ({
    name: "Bash",
    input: { command: `cmd-${i}` },
    output: "z".repeat(400),
  }));
  const out = buildExtractionAgentUserMessage({
    manifest: "",
    messages: [{ role: "assistant", text: "many tools", toolCalls: calls }],
  });
  assert.ok(
    out.includes("omitted because of the window limit"),
    "emits the window-cap omission note",
  );
  // Total folded tool text stays bounded near the window cap (not 60 * ~450).
  assert.ok(out.length < 6000, `bounded total, got ${out.length}`);
});
