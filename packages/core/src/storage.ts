/**
 * Single-document CRUD over typed directories, atomic, with privacy enforcement
 * and audit records.
 */

import { readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";

import { type MemoryDocument, type MemoryFrontmatter, type MemoryType } from "./types.js";
import { parseDocument, serializeDocument, isSingleLineValue } from "./frontmatter.js";
import {
  getTypedMemoryPath,
  resolveRelativePath,
  isValidMemoryFilename,
  normalizeRelativePath,
} from "./paths.js";
import { enforceWritePrivacy } from "./privacy.js";
import { atomicWriteFile } from "./atomic.js";
import { type AuditLogger } from "./audit.js";

export interface StorageContext {
  root: string;
  audit: AuditLogger;
}

/** Read+parse one doc by relativePath. null on ENOENT / invalid. */
export async function readMemoryDocument(
  ctx: StorageContext,
  relativePath: string,
): Promise<MemoryDocument | null> {
  const abs = resolveRelativePath(ctx.root, relativePath);
  if (!abs) return null;
  try {
    const raw = await readFile(abs, "utf8");
    return parseDocument(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export class InvalidMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryError";
  }
}

function validateFrontmatterFields(fm: MemoryFrontmatter): void {
  if (!fm.name || !isSingleLineValue(fm.name)) {
    throw new InvalidMemoryError("frontmatter.name must be a non-empty single-line value");
  }
  if (!isSingleLineValue(fm.description ?? "")) {
    throw new InvalidMemoryError("frontmatter.description must be single-line");
  }
}

/**
 * Write/overwrite a doc into its typed dir (atomic). Stamps updated_at on every
 * write; created_at only on first write (preserved from disk if present).
 * Validates filename + frontmatter + privacy BEFORE writing.
 * Returns the relativePath actually written.
 */
export async function writeMemoryDocument(
  ctx: StorageContext,
  input: { type: MemoryType; filename: string; doc: MemoryDocument; refuseSecrets?: boolean },
): Promise<string> {
  const { type, filename, doc, refuseSecrets } = input;

  if (!isValidMemoryFilename(ctx.root, filename)) {
    throw new InvalidMemoryError(`invalid memory filename: ${filename}`);
  }
  const targetPath = getTypedMemoryPath(ctx.root, type, filename);
  if (!targetPath) {
    throw new InvalidMemoryError(`cannot resolve path for type=${type} filename=${filename}`);
  }

  validateFrontmatterFields(doc.frontmatter);

  const safeBody = enforceWritePrivacy(doc.body, { refuseSecrets });
  if (!safeBody.trim()) {
    throw new InvalidMemoryError("memory body is empty after privacy redaction");
  }

  const now = new Date().toISOString();
  let createdAt = doc.frontmatter.created_at;

  // Preserve existing created_at if the file already exists.
  try {
    const existingRaw = await readFile(targetPath, "utf8");
    const existing = parseDocument(existingRaw);
    if (existing?.frontmatter.created_at) {
      createdAt = existing.frontmatter.created_at;
    }
  } catch {
    // First write.
  }
  if (!createdAt) createdAt = now;

  const frontmatter: MemoryFrontmatter = {
    name: doc.frontmatter.name,
    description: doc.frontmatter.description ?? "",
    type,
    created_at: createdAt,
    updated_at: now,
  };
  // Preserve the model-authored event date. occurred_on is the EVENT time, set
  // by the extractor when a fact is bound to a resolvable date — distinct from
  // the write-time created_at/updated_at above. Dropping it here would silently
  // discard the only structured temporal field.
  if (doc.frontmatter.occurred_on) frontmatter.occurred_on = doc.frontmatter.occurred_on;

  const serialized = serializeDocument({ frontmatter, body: safeBody });
  await atomicWriteFile(targetPath, serialized);

  const relativePath = normalizeRelativePath(path.relative(ctx.root, targetPath));
  await ctx.audit.append({ ts: now, action: "write", path: relativePath });
  return relativePath;
}

/** Delete a doc. Returns false if it did not exist. */
export async function deleteMemoryDocument(
  ctx: StorageContext,
  relativePath: string,
): Promise<boolean> {
  const abs = resolveRelativePath(ctx.root, relativePath);
  if (!abs) return false;
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  await ctx.audit.append({
    ts: new Date().toISOString(),
    action: "delete",
    path: normalizeRelativePath(relativePath),
  });
  return true;
}

/**
 * Archive a doc into .archive/<original-relative-path>. The dot prefix keeps
 * archived files out of scanMemoryFiles / health / the index (both directory
 * walkers skip dot-dirs), so a retired memory neither leaks back into recall nor
 * gets resurrected by a later dream relocate. Returns the archived relativePath,
 * or null. Archived files remain readable by their explicit `.archive/...` path.
 */
export async function archiveMemoryDocument(
  ctx: StorageContext,
  relativePath: string,
): Promise<string | null> {
  const abs = resolveRelativePath(ctx.root, relativePath);
  if (!abs) return null;

  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const archiveRel = normalizeRelativePath(path.join(".archive", relativePath));
  const archiveAbs = path.join(ctx.root, archiveRel);
  await atomicWriteFile(archiveAbs, raw);
  await unlink(abs).catch(() => {});

  await ctx.audit.append({
    ts: new Date().toISOString(),
    action: "archive",
    path: normalizeRelativePath(relativePath),
    detail: archiveRel,
  });
  return archiveRel;
}

/** mtime in ms for a relativePath, or null if missing. */
export async function memoryMtime(ctx: StorageContext, relativePath: string): Promise<number | null> {
  const abs = resolveRelativePath(ctx.root, relativePath);
  if (!abs) return null;
  try {
    const st = await stat(abs);
    return st.mtimeMs;
  } catch {
    return null;
  }
}
