/**
 * Path resolution, typed directories, and filename validation.
 *
 * Keeps the memory-path design explicit and host-neutral. `root` is
 * threaded explicitly (no module singleton) so the kernel is testable and embeddable.
 *
 * Root resolution avoids host-specific Electron `app.getPath('appData')`
 * coupling with a pure-Node strategy: MEMSCRIBE_HOME env
 * wins, else an OS data dir.
 */

import { homedir, platform } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import { RESERVED_MEMORY_FILES, MEMORY_TYPE_DIRECTORIES, type MemoryType } from "./types.js";

function osDataDir(): string {
  const plat = platform();
  if (plat === "win32") {
    return process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  }
  if (plat === "darwin") {
    return path.join(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
}

/**
 * Resolve the memory root directory.
 * Precedence: opts.root → MEMSCRIBE_HOME env → <os-data-dir>/memscribe/memory.
 */
export function getMemoryRoot(opts?: { root?: string }): string {
  if (opts?.root) return path.resolve(opts.root);
  const fromEnv = process.env.MEMSCRIBE_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(osDataDir(), "memscribe", "memory");
}

export async function ensureMemoryDir(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

export function normalizeRelativePath(p: string): string {
  return String(p || "").replace(/\\/g, "/");
}

function normalizeMemoryPath(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

/**
 * Full implementation of isValidMemoryFilename from the file-native memory design.
 * Rejects: empty, NUL, absolute, hidden segments, "."/"..", non-normalized,
 * non-.md basename, reserved names, and traversal outside root.
 */
export function isValidMemoryFilename(root: string, filename: string): boolean {
  if (!filename || typeof filename !== "string") return false;
  if (filename.includes("\0")) return false;

  const raw = normalizeMemoryPath(filename).trim();
  if (!raw) return false;
  if (path.posix.isAbsolute(raw)) return false;
  if (raw.startsWith(".")) return false;

  const rawSegments = raw.split("/");
  if (
    rawSegments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    return false;
  }

  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === "..") return false;
  if (normalized !== raw) return false;

  const basename = rawSegments[rawSegments.length - 1] ?? "";
  if (!basename.endsWith(".md")) return false;
  if (RESERVED_MEMORY_FILES.has(basename)) return false;

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/** type → absolute typed directory, or null for an invalid type. */
export function getTypedMemoryDir(root: string, type: string): string | null {
  const key = String(type || "").trim().toLowerCase();
  const directory = (MEMORY_TYPE_DIRECTORIES as Record<string, string>)[key];
  if (!directory) return null;
  return path.join(root, directory);
}

/**
 * (type, flat-filename) → absolute path, or null if invalid.
 * Only flat filenames are accepted (no nested paths).
 */
export function getTypedMemoryPath(root: string, type: string, filename: string): string | null {
  const directory = getTypedMemoryDir(root, type);
  if (!directory) return null;

  const raw = normalizeMemoryPath(filename).trim();
  if (!raw) return null;
  const segments = raw.split("/");
  if (segments.length !== 1) return null;
  if (!isValidMemoryFilename(root, raw)) return null;

  return path.join(directory, segments[0] as string);
}

/** Resolve a relativePath to an absolute path inside root, or null if it escapes. */
export function resolveRelativePath(root: string, relativePath: string): string | null {
  const raw = normalizeMemoryPath(relativePath).trim();
  if (!raw) return null;
  if (raw.includes("\0")) return null;
  if (path.posix.isAbsolute(raw)) return null;

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, raw);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * Derive a deterministic flat slug filename (ending in .md) from a memory name.
 * The subagent thinks in `type`+`name`; the host owns the path. Keeps a–z, 0–9,
 * and CJK; collapses everything else to hyphens; caps at 80 chars.
 */
export function deriveMemoryFilename(name: string): string {
  const slug = String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "memory"}.md`;
}

export function memoryTypeForRelativePath(relativePath: string): MemoryType | null {
  const first = normalizeRelativePath(relativePath).split("/")[0] ?? "";
  return (MEMORY_TYPE_DIRECTORIES as Record<string, string>)[first]
    ? (first as MemoryType)
    : null;
}
