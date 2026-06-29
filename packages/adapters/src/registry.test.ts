import { test } from "node:test";
import assert from "node:assert/strict";

import { ADAPTERS, adapterIds, getAdapter } from "./registry.js";
import { normalizeMessages } from "./make-adapter.js";
import type { MemFlywheelHook } from "./adapter.js";

const REQUIRED_HOOKS: MemFlywheelHook[] = ["onPromptBuild", "onTurnEnd"];

test("registry contains the built-in open harness adapters with unique ids", () => {
  assert.deepEqual(adapterIds().sort(), ["hermes", "openclaw", "opencode", "pi"]);
  assert.equal(new Set(adapterIds()).size, ADAPTERS.length);
});

test("getAdapter resolves known ids and returns undefined otherwise", () => {
  assert.equal(getAdapter("pi")?.id, "pi");
  assert.equal(getAdapter("nope"), undefined);
});

test("every adapter has a self-consistent lifecycle map", () => {
  for (const adapter of ADAPTERS) {
    for (const hook of REQUIRED_HOOKS) {
      const mapping = adapter.lifecycle[hook];
      assert.ok(mapping, `${adapter.id} missing ${hook}`);
    }
    for (const hook of Object.keys(adapter.lifecycle) as MemFlywheelHook[]) {
      const mapping = adapter.lifecycle[hook];
      assert.ok(mapping, `${adapter.id} missing ${hook}`);
      // The map key must equal the mapping's declared hook.
      assert.equal(mapping.hook, hook, `${adapter.id}.${hook} hook mismatch`);
      assert.ok(mapping.hostEvent.length > 0, `${adapter.id}.${hook} empty hostEvent`);
      assert.ok(mapping.note.length > 0, `${adapter.id}.${hook} empty note`);
    }
    // Host events must be distinct within an adapter.
    const events = Object.values(adapter.lifecycle).map((mapping) => mapping.hostEvent);
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
