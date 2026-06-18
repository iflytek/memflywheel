/**
 * Atomic file writes: write to a temp file in the same directory, fsync, then
 * rename over the target. rename is atomic on the same filesystem.
 */

import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicWriteFile(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Append a line (atomically appended via the OS append flag). */
export async function appendFileLine(target: string, line: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "a");
  try {
    await handle.writeFile(line.endsWith("\n") ? line : `${line}\n`, "utf8");
  } finally {
    await handle.close();
  }
}
