/**
 * Per-root write mutex with explicit acquire/release semantics.
 *
 * Lock file is JSON { pid, owner, startedAt }. A lock is stale when the holder
 * process is gone (process.kill(pid,0) throws) OR it has exceeded the timeout.
 * Acquisition uses an exclusive create (flag "wx").
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import { ensureMemoryDir } from "./paths.js";

export const LOCK_TIMEOUT_MS = 3 * 60 * 1000;
export const LOCK_FILE = ".memory-task-lock";

export interface LockHandle {
  acquired: boolean;
  lockPath: string;
}

interface LockContent {
  pid: number;
  owner: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(root: string, owner = "memory-task"): Promise<LockHandle> {
  await ensureMemoryDir(root);
  const lockPath = path.join(root, LOCK_FILE);

  try {
    const existing = await readFile(lockPath, "utf8");
    const lock = JSON.parse(existing) as Partial<LockContent>;

    let isStale = false;
    if (typeof lock.pid !== "number" || !isProcessAlive(lock.pid)) {
      isStale = true;
    }
    if (!isStale && lock.startedAt) {
      const elapsed = Date.now() - new Date(lock.startedAt).getTime();
      if (Number.isNaN(elapsed) || elapsed > LOCK_TIMEOUT_MS) {
        isStale = true;
      }
    }

    if (!isStale) {
      return { acquired: false, lockPath };
    }

    await unlink(lockPath).catch(() => {});
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Corrupt or unreadable lock — treat as reclaimable.
      await unlink(lockPath).catch(() => {});
    }
  }

  const content: LockContent = {
    pid: process.pid,
    owner,
    startedAt: new Date().toISOString(),
  };

  try {
    await writeFile(lockPath, JSON.stringify(content), { flag: "wx" });
    return { acquired: true, lockPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { acquired: false, lockPath };
    }
    throw err;
  }
}

export async function releaseLock(root: string): Promise<void> {
  const lockPath = path.join(root, LOCK_FILE);
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** Run a function while holding the lock; releases even on throw. Returns null if not acquired. */
export async function withLock<T>(
  root: string,
  owner: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const handle = await acquireLock(root, owner);
  if (!handle.acquired) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}
