import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryTools,
  memoryToolMap,
  type MemoryToolContext,
} from "./memory-tools.js";
import { type StorageContext, readMemoryDocument } from "./storage.js";
import { readMemoryIndex } from "./index-file.js";
import { createNullAuditLogger } from "./audit.js";
import { makeRoot, cleanup } from "./test-helpers.js";

function tools(root: string, refuseSecrets = false) {
  const ctx: StorageContext = { root, audit: createNullAuditLogger() };
  const toolCtx: MemoryToolContext = { ctx, refuseSecrets };
  const map = memoryToolMap(createMemoryTools());
  return { ctx, toolCtx, map };
}

test("tool schemas are object schemas with additionalProperties:false", () => {
  for (const t of createMemoryTools()) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(t.inputSchema.required));
  }
  const names = createMemoryTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    "memory_archive",
    "memory_list",
    "memory_read",
    "memory_save",
    "memory_search",
    "memory_update",
  ]);
});

test("memory_read returns the full current body of one memory", async () => {
  const root = await makeRoot();
  try {
    const { toolCtx, map } = tools(root);
    await map.get("memory_save")!.handler(
      { type: "preference", name: "Drinks", body: "Prefers green tea and oolong." },
      toolCtx,
    );
    const res = await map.get("memory_read")!.handler({ relativePath: "preference/drinks.md" }, toolCtx);
    assert.equal(res.ok, true);
    assert.ok(res.text.includes("Prefers green tea and oolong."));
    assert.ok(res.text.includes("type: preference"));

    const miss = await map.get("memory_read")!.handler({ relativePath: "preference/nope.md" }, toolCtx);
    assert.equal(miss.ok, false);
  } finally {
    await cleanup(root);
  }
});

test("memory_search locates existing memories by content (name/description/body)", async () => {
  const root = await makeRoot();
  try {
    const { toolCtx, map } = tools(root);
    await map.get("memory_save")!.handler(
      { type: "preference", name: "Drinks", body: "Prefers green tea." },
      toolCtx,
    );
    await map.get("memory_save")!.handler(
      { type: "workflow", name: "Testing habit", body: "Runs the full suite before committing." },
      toolCtx,
    );

    const hit = await map.get("memory_search")!.handler({ query: "tea" }, toolCtx);
    assert.equal(hit.ok, true);
    assert.ok(hit.text.includes("preference/drinks.md"));
    assert.ok(!hit.text.includes("workflow/testing-habit.md"));

    const typed = await map.get("memory_search")!.handler({ query: "suite", type: "workflow" }, toolCtx);
    assert.ok(typed.text.includes("workflow/testing-habit.md"));

    const none = await map.get("memory_search")!.handler({ query: "kubernetes" }, toolCtx);
    assert.ok(none.text.includes("no memories match"));
  } finally {
    await cleanup(root);
  }
});

test("progressive update: read then memory_update appends without dropping existing items", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    // A list-type preference already on disk.
    await map.get("memory_save")!.handler(
      { type: "preference", name: "Favorite drinks", description: "Beverages", body: "Likes green tea." },
      toolCtx,
    );
    // Subagent flow: read the real body, then update with the existing content PLUS the new item.
    const read = await map.get("memory_read")!.handler(
      { relativePath: "preference/favorite-drinks.md" },
      toolCtx,
    );
    assert.ok(read.text.includes("Likes green tea."));
    const upd = await map.get("memory_update")!.handler(
      { relativePath: "preference/favorite-drinks.md", body: "Likes green tea. Also likes black coffee." },
      toolCtx,
    );
    assert.equal(upd.ok, true);

    const doc = await readMemoryDocument(ctx, "preference/favorite-drinks.md");
    assert.ok(doc?.body.includes("green tea"), "existing item retained");
    assert.ok(doc?.body.includes("black coffee"), "new item appended");
  } finally {
    await cleanup(root);
  }
});

test("memory_save derives a filename, writes, and resyncs the index", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    const res = await map.get("memory_save")!.handler(
      { type: "preference", name: "Beverage preference", description: "Drinks", body: "Prefers green tea." },
      toolCtx,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.changed, ["preference/beverage-preference.md"]);

    const doc = await readMemoryDocument(ctx, "preference/beverage-preference.md");
    assert.equal(doc?.body, "Prefers green tea.");

    const index = await readMemoryIndex(root);
    assert.ok(index.includes("beverage-preference.md"));
  } finally {
    await cleanup(root);
  }
});

test("memory_save rejects invalid type and empty body without throwing", async () => {
  const root = await makeRoot();
  try {
    const { toolCtx, map } = tools(root);
    const bad = await map.get("memory_save")!.handler(
      { type: "bogus", name: "x", body: "y" },
      toolCtx,
    );
    assert.equal(bad.ok, false);
    const empty = await map.get("memory_save")!.handler(
      { type: "identity", name: "x", body: "   " },
      toolCtx,
    );
    assert.equal(empty.ok, false);
  } finally {
    await cleanup(root);
  }
});

test("memory_save redacts <private> spans deterministically (gate off)", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    const fakeSecret = "sk" + "-secret-value";
    const res = await map.get("memory_save")!.handler(
      { type: "context", name: "Token note", body: `The key is <private>${fakeSecret}</private> here.` },
      toolCtx,
    );
    assert.equal(res.ok, true);
    const doc = await readMemoryDocument(ctx, "context/token-note.md");
    assert.ok(doc?.body.includes("[REDACTED]"));
    assert.ok(!doc?.body.includes(fakeSecret));
  } finally {
    await cleanup(root);
  }
});

test("memory_save secret gate refuses obvious secrets only when enabled", async () => {
  const root = await makeRoot();
  try {
    const fakePassword = "pass" + "word: hunter2xx";
    // Gate ON → refused.
    const on = tools(root, true);
    const refused = await on.map.get("memory_save")!.handler(
      { type: "context", name: "Leak", body: fakePassword },
      on.toolCtx,
    );
    assert.equal(refused.ok, false);
    assert.ok(/refused/.test(refused.text));
    assert.equal(await readMemoryDocument(on.ctx, "context/leak.md"), null);

    // Gate OFF (default) → written as-is after <private> redaction.
    const off = tools(root, false);
    const written = await off.map.get("memory_save")!.handler(
      { type: "context", name: "Leak2", body: fakePassword },
      off.toolCtx,
    );
    assert.equal(written.ok, true);
    assert.ok(await readMemoryDocument(off.ctx, "context/leak2.md"));
  } finally {
    await cleanup(root);
  }
});

test("memory_update edits an existing file by relative path", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    await map.get("memory_save")!.handler(
      { type: "preference", name: "Drinks", body: "Prefers tea." },
      toolCtx,
    );
    const upd = await map.get("memory_update")!.handler(
      { relativePath: "preference/drinks.md", body: "Prefers tea and dislikes coffee." },
      toolCtx,
    );
    assert.equal(upd.ok, true);
    const doc = await readMemoryDocument(ctx, "preference/drinks.md");
    assert.equal(doc?.body, "Prefers tea and dislikes coffee.");
    // name preserved (not overridden).
    assert.equal(doc?.frontmatter.name, "Drinks");
  } finally {
    await cleanup(root);
  }
});

test("memory_update returns not-found for a missing path", async () => {
  const root = await makeRoot();
  try {
    const { toolCtx, map } = tools(root);
    const res = await map.get("memory_update")!.handler(
      { relativePath: "preference/missing.md", body: "x" },
      toolCtx,
    );
    assert.equal(res.ok, false);
    assert.ok(/not found/.test(res.text));
  } finally {
    await cleanup(root);
  }
});

test("memory_archive retires a file and resyncs the index", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    await map.get("memory_save")!.handler(
      { type: "identity", name: "Old name", body: "Call me X." },
      toolCtx,
    );
    const arc = await map.get("memory_archive")!.handler(
      { relativePath: "identity/old-name.md" },
      toolCtx,
    );
    assert.equal(arc.ok, true);
    assert.equal(await readMemoryDocument(ctx, "identity/old-name.md"), null);
    assert.ok(await readMemoryDocument(ctx, ".archive/identity/old-name.md"));
  } finally {
    await cleanup(root);
  }
});

test("memory_list reflects prior writes within the same context", async () => {
  const root = await makeRoot();
  try {
    const { toolCtx, map } = tools(root);
    const empty = await map.get("memory_list")!.handler({}, toolCtx);
    assert.ok(empty.text.includes("no existing memories"));

    await map.get("memory_save")!.handler(
      { type: "preference", name: "Editor", body: "Uses vim." },
      toolCtx,
    );
    const listed = await map.get("memory_list")!.handler({ type: "preference" }, toolCtx);
    assert.ok(listed.text.includes("preference/editor.md"));
    assert.ok(listed.text.includes("Editor"));

    // Filtering by another type hides it.
    const other = await map.get("memory_list")!.handler({ type: "identity" }, toolCtx);
    assert.ok(other.text.includes("no existing memories"));
  } finally {
    await cleanup(root);
  }
});
