/** Cross-process write mutex for one memory root. */

import path from "node:path";

import lockfile from "proper-lockfile";

import { ensureMemoryDir } from "./paths.js";

export const LOCK_TIMEOUT_MS = 3 * 60 * 1000;
export const LOCK_FILE = ".memory-task-lock";

export interface LockHandle {
  lockPath: string;
  owner: string;
  release(): Promise<void>;
}

/**
 * Acquire the root lock, waiting for the current writer instead of reporting a
 * fake queued success. Exhausting the bounded wait throws ELOCKED to the host.
 */
export async function acquireLock(root: string, owner = "memory-task"): Promise<LockHandle> {
  await ensureMemoryDir(root);
  const lockPath = path.join(root, LOCK_FILE);
  const release = await lockfile.lock(root, {
    realpath: false,
    lockfilePath: lockPath,
    stale: LOCK_TIMEOUT_MS,
    update: LOCK_TIMEOUT_MS / 3,
    retries: {
      retries: LOCK_TIMEOUT_MS / 250,
      factor: 1,
      minTimeout: 250,
      maxTimeout: 250,
      randomize: false,
    },
  });
  return { lockPath, owner, release };
}

export async function withLock<T>(root: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLock(root, owner);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
