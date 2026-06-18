import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { acquireLock, releaseLock, withLock, LOCK_FILE } from "./lock.js";
import { makeRoot, cleanup } from "./test-helpers.js";

test("acquireLock is exclusive and releaseLock frees it", async () => {
  const root = await makeRoot();
  try {
    const first = await acquireLock(root, "a");
    assert.equal(first.acquired, true);
    const second = await acquireLock(root, "b");
    assert.equal(second.acquired, false);
    await releaseLock(root);
    const third = await acquireLock(root, "c");
    assert.equal(third.acquired, true);
    await releaseLock(root);
  } finally {
    await cleanup(root);
  }
});

test("acquireLock reclaims a stale lock (dead pid)", async () => {
  const root = await makeRoot();
  try {
    const lockPath = path.join(root, LOCK_FILE);
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2147483646, owner: "ghost", startedAt: new Date().toISOString() }),
    );
    const handle = await acquireLock(root, "live");
    assert.equal(handle.acquired, true);
    const content = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(content.owner, "live");
    await releaseLock(root);
  } finally {
    await cleanup(root);
  }
});

test("withLock runs fn and releases, returns null when held", async () => {
  const root = await makeRoot();
  try {
    let ran = false;
    const result = await withLock(root, "owner", async () => {
      ran = true;
      // While held, a nested acquire should fail.
      const nested = await acquireLock(root, "nested");
      assert.equal(nested.acquired, false);
      return 42;
    });
    assert.equal(ran, true);
    assert.equal(result, 42);
    // Lock is released; can re-acquire.
    const after = await acquireLock(root, "again");
    assert.equal(after.acquired, true);
    await releaseLock(root);
  } finally {
    await cleanup(root);
  }
});
