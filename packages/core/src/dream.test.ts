import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planDeterministic,
  planDream,
  applyDream,
  runDreamSession,
  shouldRunDream,
  type DreamAgentRunner,
} from "./dream.js";
import { type StorageContext, readMemoryDocument, archiveMemoryDocument } from "./storage.js";
import { scanMemoryFiles } from "./scan.js";
import { buildHealthFindings } from "./health.js";
import { memoryToolMap } from "./memory-tools.js";
import { readDreamState, bumpDreamSessions } from "./dream-state.js";
import { createNullAuditLogger } from "./audit.js";
import { makeRoot, cleanup, writeFixture, writeRaw } from "./test-helpers.js";

function ctxFor(root: string): StorageContext {
  return { root, audit: createNullAuditLogger() };
}

test("shouldRunDream gates on time OR sessions OR force", () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 0 }), false);
  assert.equal(shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 5 }), true);
  assert.equal(
    shouldRunDream({
      now,
      lastConsolidatedAt: now - 25 * 60 * 60 * 1000,
      candidateSessionCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 0, force: true }),
    true,
  );
});

test("shouldRunDream: threshold boundaries are inclusive (>=)", () => {
  const now = 1_000_000_000_000;
  const H = 60 * 60 * 1000;
  // Time exactly at the 24h threshold fires; one ms short does not.
  assert.equal(shouldRunDream({ now, lastConsolidatedAt: now - 24 * H, candidateSessionCount: 0 }), true);
  assert.equal(
    shouldRunDream({ now, lastConsolidatedAt: now - (24 * H - 1), candidateSessionCount: 0 }),
    false,
  );
  // Sessions exactly at the threshold fires; one short does not.
  assert.equal(shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 5 }), true);
  assert.equal(shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 4 }), false);
  // Custom thresholds.
  assert.equal(
    shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 2, minSessions: 2 }),
    true,
  );
  assert.equal(
    shouldRunDream({ now, lastConsolidatedAt: now - 2 * H, candidateSessionCount: 0, minHours: 2 }),
    true,
  );
  // lastConsolidatedAt=null never satisfies the time gate.
  assert.equal(shouldRunDream({ now, lastConsolidatedAt: null, candidateSessionCount: 0 }), false);
});

test("planDeterministic proposes delete-duplicate for identical content", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "style", "a.md", { name: "A", body: "identical body", mtime: 1 });
    await writeFixture(root, "style", "b.md", { name: "B", body: "identical body", mtime: 2 });
    const entries = await scanMemoryFiles(root);
    const ops = await planDeterministic(root, entries);
    assert.ok(ops.some((o) => o.kind === "delete-duplicate"));
  } finally {
    await cleanup(root);
  }
});

test("applyDream deletes a duplicate and resyncs index", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await writeFixture(root, "style", "a.md", { name: "A", body: "dup body", mtime: 1 });
    await writeFixture(root, "style", "b.md", { name: "B", body: "dup body", mtime: 2 });

    const plan = await planDream({ root });
    const result = await applyDream({ ctx, plan });

    assert.equal(result.deleted.length, 1);
    const after = await scanMemoryFiles(root);
    assert.equal(after.length, 1);
  } finally {
    await cleanup(root);
  }
});

test("applyDream relocates a path-type-mismatch file via the deterministic plan", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    // identity/ dir but declares type preference.
    await writeRaw(root, "identity/mis.md", "---\nname: 错位\ntype: preference\n---\n\n正文");

    const plan = await planDream({ root });
    const result = await applyDream({ ctx, plan });

    assert.ok(result.changed.includes("preference/mis.md"));
    assert.equal(await readMemoryDocument(ctx, "identity/mis.md"), null);
    const moved = await readMemoryDocument(ctx, "preference/mis.md");
    assert.equal(moved?.frontmatter.type, "preference");
  } finally {
    await cleanup(root);
  }
});

test("runDreamSession runs only the deterministic pre-pass when no runner is given", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await writeFixture(root, "style", "a.md", { name: "A", body: "dup body", mtime: 1 });
    await writeFixture(root, "style", "b.md", { name: "B", body: "dup body", mtime: 2 });

    const result = await runDreamSession({ ctx });
    assert.equal(result.ran, true);
    assert.equal(result.reason, "ok");
    assert.equal(result.deleted.length, 1);
    assert.equal((await scanMemoryFiles(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("runDreamSession: deterministic pre-pass, then the subagent merges via tools without losing data", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    // A structural duplicate (handled deterministically) ...
    await writeFixture(root, "style", "a.md", { name: "A", body: "same style", mtime: 1 });
    await writeFixture(root, "style", "b.md", { name: "B", body: "same style", mtime: 2 });
    // ... plus two same-topic preferences the subagent should merge.
    await writeFixture(root, "preference", "green-tea.md", {
      name: "Green tea",
      body: "Likes green tea.",
      mtime: 3,
    });
    await writeFixture(root, "preference", "americano.md", {
      name: "Americano",
      body: "Likes americano coffee.",
      mtime: 4,
    });

    // A fake consolidation subagent: read both drinks in full, save ONE merged
    // memory keeping every item, archive the sources. This is the tool-driven
    // equivalent of a merge op.
    const runner: DreamAgentRunner = async ({ tools, toolCtx }) => {
      const map = memoryToolMap(tools);
      const read = map.get("memory_read")!;
      const save = map.get("memory_save")!;
      const archive = map.get("memory_archive")!;

      const tea = await read.handler({ relativePath: "preference/green-tea.md" }, toolCtx);
      const coffee = await read.handler({ relativePath: "preference/americano.md" }, toolCtx);
      assert.ok(tea.ok && coffee.ok);

      const changed: string[] = [];
      const saved = await save.handler(
        {
          type: "preference",
          name: "Drinks",
          description: "drink preferences",
          body: "Likes green tea and americano coffee.",
        },
        toolCtx,
      );
      if (saved.ok && saved.changed) changed.push(...saved.changed);
      await archive.handler({ relativePath: "preference/green-tea.md" }, toolCtx);
      await archive.handler({ relativePath: "preference/americano.md" }, toolCtx);
      return { changed };
    };

    const result = await runDreamSession({ ctx, runner });
    assert.equal(result.ran, true);
    assert.equal(result.reason, "ok");

    // Deterministic pre-pass removed the style duplicate.
    const style = (await scanMemoryFiles(root)).filter((e) => e.type === "style");
    assert.equal(style.length, 1);

    // The subagent's merge: sources gone, one combined memory keeps both items.
    assert.equal(await readMemoryDocument(ctx, "preference/green-tea.md"), null);
    assert.equal(await readMemoryDocument(ctx, "preference/americano.md"), null);
    const merged = await readMemoryDocument(ctx, "preference/drinks.md");
    assert.match(merged?.body ?? "", /green tea/i);
    assert.match(merged?.body ?? "", /coffee/i);
    assert.ok(result.changed.includes("preference/drinks.md"));
  } finally {
    await cleanup(root);
  }
});

test("runDreamSession reports runner-failed when the subagent throws, but the pre-pass still applies", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await writeFixture(root, "style", "a.md", { name: "A", body: "dup body", mtime: 1 });
    await writeFixture(root, "style", "b.md", { name: "B", body: "dup body", mtime: 2 });

    await bumpDreamSessions(root, 6);
    const runner: DreamAgentRunner = async () => {
      throw new Error("boom");
    };
    const result = await runDreamSession({ ctx, runner });
    assert.equal(result.ran, true);
    assert.equal(result.reason, "runner-failed");
    // The deterministic pre-pass already ran before the subagent.
    assert.equal((await scanMemoryFiles(root)).length, 1);
    // ...but a FAILED pass must NOT advance the gate: no timestamp, counter kept,
    // so the next idle tick retries instead of waiting a full window.
    const st = await readDreamState(root);
    assert.equal(st.lastConsolidatedAt, null);
    assert.equal(st.sessionsSince, 6);
  } finally {
    await cleanup(root);
  }
});

test("archived memories stay out of scan/health/index and are NOT resurrected by a later dream", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await writeFixture(root, "preference", "coffee.md", { name: "Coffee", body: "Likes americano.", mtime: 1 });
    await writeFixture(root, "preference", "tea.md", { name: "Tea", body: "Likes green tea.", mtime: 2 });

    // What a dream merge does to a folded-in source.
    const archived = await archiveMemoryDocument(ctx, "preference/coffee.md");
    assert.equal(archived, ".archive/preference/coffee.md");

    // The archived file does not re-enter the scan...
    const entries = await scanMemoryFiles(root);
    assert.ok(!entries.some((e) => e.relativePath.startsWith(".archive/")), "scan excludes .archive");
    assert.equal(entries.length, 1);

    // ...nor health (no path-type-mismatch on the archived copy)...
    const findings = await buildHealthFindings(root);
    assert.ok(!findings.some((f) => f.paths.some((p) => p.startsWith(".archive/"))), "health ignores .archive");

    // ...so a later dream's deterministic plan does NOT relocate it back to life.
    assert.deepEqual(await planDream({ root }), []);

    // But it stays readable by its explicit .archive/ path (recovery-friendly).
    assert.ok(await readMemoryDocument(ctx, ".archive/preference/coffee.md"));
  } finally {
    await cleanup(root);
  }
});

test("runDreamSession stamps the gate state and resets the session count", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await bumpDreamSessions(root, 7);
    const before = await readDreamState(root);
    assert.equal(before.lastConsolidatedAt, null);
    assert.equal(before.sessionsSince, 7);

    const result = await runDreamSession({ ctx }); // empty store, no runner
    assert.equal(result.ran, true);

    const after = await readDreamState(root);
    assert.notEqual(after.lastConsolidatedAt, null); // last consolidation stamped
    assert.equal(after.sessionsSince, 0); // counter reset
  } finally {
    await cleanup(root);
  }
});

test("a locked dream pass does not run and does not stamp the gate state", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await bumpDreamSessions(root, 3);
    const { acquireLock, releaseLock } = await import("./lock.js");
    const held = await acquireLock(root, "other");
    assert.equal(held.acquired, true);
    try {
      const result = await runDreamSession({ ctx });
      assert.equal(result.ran, false);
      assert.equal(result.reason, "locked");
      // State untouched: no stamp, counter preserved.
      const st = await readDreamState(root);
      assert.equal(st.lastConsolidatedAt, null);
      assert.equal(st.sessionsSince, 3);
    } finally {
      await releaseLock(root);
    }
  } finally {
    await cleanup(root);
  }
});
