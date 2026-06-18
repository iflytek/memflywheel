/**
 * Domain types and constants for the MemScribe memory kernel.
 *
 * The persisted frontmatter carries only `name` / `description` / `type` (plus
 * minimal `created_at` / `updated_at`). The six memory categories are the
 * canonical VALID_MEMORY_TYPES.
 */

export type MemoryType =
  | "identity"
  | "preference"
  | "style"
  | "workflow"
  | "context"
  | "ambient";

/**
 * Persisted YAML frontmatter. NOTHING beyond these fields.
 * (No scope / origin / source_ref / confidence / status / agent / project / session.)
 */
export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  created_at?: string;
  updated_at?: string;
}

/** A parsed memory file (frontmatter + body). */
export interface MemoryDocument {
  frontmatter: MemoryFrontmatter;
  body: string;
}

/** Scan entry — the shape produced by scanMemoryFiles(). */
export interface MemoryEntry {
  filename: string;
  relativePath: string;
  name: string;
  description: string;
  type: MemoryType;
  mtime: number;
}

export const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "identity",
  "preference",
  "style",
  "workflow",
  "context",
  "ambient",
]);

export const MEMORY_TYPE_DIRECTORIES: Readonly<Record<MemoryType, string>> = {
  identity: "identity",
  preference: "preference",
  style: "style",
  workflow: "workflow",
  context: "context",
  ambient: "ambient",
};

export const RESERVED_MEMORY_FILES: ReadonlySet<string> = new Set([
  "MEMORY.md",
  ".memory-task-lock",
  ".last-extraction",
  ".consolidate-lock",
  ".audit.log",
]);

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && VALID_MEMORY_TYPES.has(value as MemoryType);
}
