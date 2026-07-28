import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, utimes } from "node:fs/promises";
import path from "node:path";

import { acquireLock, withLock, LOCK_FILE, LOCK_TIMEOUT_MS } from "./lock.js";
import { makeRoot, cleanup } from "./test-helpers.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("acquireLock waits for the current writer and then acquires", async () => {
  const root = await makeRoot();
  try {
    const first = await acquireLock(root, "a");
    let acquired = false;
    const secondPromise = acquireLock(root, "b").then((handle) => {
      acquired = true;
      return handle;
    });
    await delay(50);
    assert.equal(acquired, false);
    await first.release();
    const second = await secondPromise;
    assert.equal(second.owner, "b");
    await second.release();
  } finally {
    await cleanup(root);
  }
});

test("acquireLock reclaims a stale proper-lockfile directory", async () => {
  const root = await makeRoot();
  try {
    const lockPath = path.join(root, LOCK_FILE);
    await mkdir(lockPath);
    const stale = new Date(Date.now() - LOCK_TIMEOUT_MS - 1_000);
    await utimes(lockPath, stale, stale);
    const handle = await acquireLock(root, "live");
    assert.equal(handle.owner, "live");
    await handle.release();
  } finally {
    await cleanup(root);
  }
});

test("withLock serializes concurrent critical sections", async () => {
  const root = await makeRoot();
  try {
    const events: string[] = [];
    const first = withLock(root, "first", async () => {
      events.push("first:start");
      await delay(75);
      events.push("first:end");
      return 1;
    });
    await delay(10);
    const second = withLock(root, "second", async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    await cleanup(root);
  }
});
