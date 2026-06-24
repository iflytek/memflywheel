/**
 * Domain types and constants for the MemFlywheel memory kernel.
 *
 * The persisted frontmatter carries `name` / `description` / `type`, optional
 * retrieval routing terms, and minimal write/event timestamps. The six memory
 * categories are the canonical VALID_MEMORY_TYPES.
 */

export type MemoryType =
  | "identity"
  | "preference"
  | "style"
  | "workflow"
  | "context"
  | "ambient";

/**
 * Persisted YAML frontmatter. Beyond the core fields only `occurred_on` and
 * `retrieval_terms` are allowed. (No scope / origin / source_ref / confidence /
 * status / agent / project / session.)
 *
 * `created_at` / `updated_at` are WRITE times (when the memory was recorded).
 * `occurred_on` is the EVENT time — when the remembered fact actually happened —
 * resolved to an absolute ISO date (YYYY-MM-DD). It is distinct from the write
 * times and is only present when a fact is bound to a specific date that the
 * extractor could resolve from an explicit time anchor; it is never guessed.
 */
export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  created_at?: string;
  updated_at?: string;
  occurred_on?: string;
  retrieval_terms?: string[];
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
  occurredOn?: string;
  retrievalTerms?: string[];
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
