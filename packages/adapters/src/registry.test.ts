import { test } from "node:test";
import assert from "node:assert/strict";

import { ADAPTERS, adapterIds, getAdapter } from "./registry.js";
import { normalizeMessages } from "./make-adapter.js";
import type { MemScribeHook } from "./adapter.js";

const ALL_HOOKS: MemScribeHook[] = ["onSessionStart", "onPromptBuild", "onTurnEnd", "onIdle"];

test("registry contains all six built-in adapters with unique ids", () => {
  assert.deepEqual(
    adapterIds().sort(),
    ["claude-code", "codex", "hermes", "openclaw", "opencode", "pi"],
  );
  assert.equal(new Set(adapterIds()).size, ADAPTERS.length);
});

test("getAdapter resolves known ids and returns undefined otherwise", () => {
  assert.equal(getAdapter("pi")?.id, "pi");
  assert.equal(getAdapter("claude-code")?.name, "Claude Code");
  assert.equal(getAdapter("nope"), undefined);
});

test("every adapter has a complete lifecycle map with self-consistent hooks", () => {
  for (const adapter of ADAPTERS) {
    for (const hook of ALL_HOOKS) {
      const mapping = adapter.lifecycle[hook];
      assert.ok(mapping, `${adapter.id} missing ${hook}`);
      // The map key must equal the mapping's declared hook.
      assert.equal(mapping.hook, hook, `${adapter.id}.${hook} hook mismatch`);
      assert.ok(mapping.hostEvent.length > 0, `${adapter.id}.${hook} empty hostEvent`);
      assert.ok(mapping.note.length > 0, `${adapter.id}.${hook} empty note`);
    }
    // Host events must be distinct within an adapter.
    const events = ALL_HOOKS.map((h) => adapter.lifecycle[h].hostEvent);
    assert.equal(new Set(events).size, events.length, `${adapter.id} duplicate hostEvents`);
  }
});

test("normalizeMessages keeps only user/assistant, coerces content, drops empties", () => {
  const out = normalizeMessages([
    { role: "user", text: "  a  " },
    { role: "assistant", content: "b" },
    { role: "system", text: "ignored" },
    { role: "user", text: "   " },
    null,
    "garbage",
    { role: "user" },
  ]);
  assert.deepEqual(out, [
    { role: "user", text: "a" },
    { role: "assistant", text: "b" },
  ]);
});

test("normalizeMessages returns [] for non-arrays", () => {
  assert.deepEqual(normalizeMessages(undefined), []);
  assert.deepEqual(normalizeMessages({}), []);
  assert.deepEqual(normalizeMessages("x"), []);
});
