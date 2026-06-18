/**
 * Shared test helpers (not a test file). Creates ephemeral memory roots and
 * writes memory documents directly to disk for fixtures.
 */

import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { serializeDocument } from "./frontmatter.js";
import { type MemoryType } from "./types.js";

export async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memscribe-test-"));
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function writeFixture(
  root: string,
  type: MemoryType,
  filename: string,
  opts: { name: string; description?: string; body: string; mtime?: number },
): Promise<string> {
  const dir = path.join(root, type);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const serialized = serializeDocument({
    frontmatter: { name: opts.name, description: opts.description ?? "", type },
    body: opts.body,
  });
  await writeFile(filePath, serialized, "utf8");
  if (opts.mtime !== undefined) {
    const t = new Date(opts.mtime);
    await utimes(filePath, t, t);
  }
  return path.join(type, filename);
}

/** Write a raw file (bypasses serialization) at a relative path under root. */
export async function writeRaw(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
