import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DREAM_STATE_FILE,
  readDreamState,
  bumpDreamSessions,
  markDreamConsolidated,
} from "./dream-state.js";
import { scanMemoryFiles } from "./scan.js";
import { makeRoot, cleanup } from "./test-helpers.js";

test("readDreamState: missing file → zero state", async () => {
  const root = await makeRoot();
  try {
    assert.deepEqual(await readDreamState(root), { lastConsolidatedAt: null, sessionsSince: 0 });
  } finally {
    await cleanup(root);
  }
});

test("readDreamState: corrupt JSON → zero state (total, never throws)", async () => {
  const root = await makeRoot();
  try {
    await writeFile(path.join(root, DREAM_STATE_FILE), "{not valid json", "utf8");
    assert.deepEqual(await readDreamState(root), { lastConsolidatedAt: null, sessionsSince: 0 });
  } finally {
    await cleanup(root);
  }
});

test("readDreamState: wrong field types / negative count → coerced to zero", async () => {
  const root = await makeRoot();
  try {
    await writeFile(
      path.join(root, DREAM_STATE_FILE),
      JSON.stringify({ lastConsolidatedAt: "nope", sessionsSince: -3 }),
      "utf8",
    );
    assert.deepEqual(await readDreamState(root), { lastConsolidatedAt: null, sessionsSince: 0 });
  } finally {
    await cleanup(root);
  }
});

test("readDreamState: a non-object payload → zero state", async () => {
  const root = await makeRoot();
  try {
    await writeFile(path.join(root, DREAM_STATE_FILE), "42", "utf8");
    assert.deepEqual(await readDreamState(root), { lastConsolidatedAt: null, sessionsSince: 0 });
  } finally {
    await cleanup(root);
  }
});

test("bumpDreamSessions: accumulates from zero, honors a delta", async () => {
  const root = await makeRoot();
  try {
    await bumpDreamSessions(root);
    await bumpDreamSessions(root);
    await bumpDreamSessions(root, 3);
    assert.equal((await readDreamState(root)).sessionsSince, 5);
  } finally {
    await cleanup(root);
  }
});

test("markDreamConsolidated: stamps the time and resets the session count", async () => {
  const root = await makeRoot();
  try {
    await bumpDreamSessions(root, 4);
    await markDreamConsolidated(root, 1_700_000_000_000);
    const s = await readDreamState(root);
    assert.equal(s.lastConsolidatedAt, 1_700_000_000_000);
    assert.equal(s.sessionsSince, 0);
  } finally {
    await cleanup(root);
  }
});

test("bump after mark counts only sessions since the last consolidation", async () => {
  const root = await makeRoot();
  try {
    await markDreamConsolidated(root, 1_700_000_000_000);
    await bumpDreamSessions(root);
    await bumpDreamSessions(root);
    const s = await readDreamState(root);
    assert.equal(s.lastConsolidatedAt, 1_700_000_000_000);
    assert.equal(s.sessionsSince, 2);
  } finally {
    await cleanup(root);
  }
});

test(".dream-state.json (dot-prefixed) stays out of the memory scan", async () => {
  const root = await makeRoot();
  try {
    await markDreamConsolidated(root, 1);
    await bumpDreamSessions(root);
    const entries = await scanMemoryFiles(root);
    assert.ok(!entries.some((e) => e.relativePath.includes("dream-state")));
  } finally {
    await cleanup(root);
  }
});
