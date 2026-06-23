/**
 * Hand-rolled frontmatter parsing/serialization (zero deps), using the reference
 * line-based parser — NOT a general YAML library.
 */

import { VALID_MEMORY_TYPES, type MemoryFrontmatter, type MemoryDocument, type MemoryType } from "./types.js";

export const FRONTMATTER_READ_BYTES = 2048;
export const MAX_FRONTMATTER_LINES = 30;

const FRONTMATTER_KEY_ORDER = ["name", "description", "type", "created_at", "updated_at", "occurred_on"] as const;

/**
 * Port of parseMemoryFrontmatter.
 * Requires `name` + `type`; `type` must be one of the six. `description`
 * defaults to "" when absent. Returns null on any structural failure.
 */
export function parseFrontmatter(content: string): MemoryFrontmatter | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1 || endIndex > MAX_FRONTMATTER_LINES) return null;

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIndex; i++) {
    const match = (lines[i] ?? "").match(/^(\w+):\s*(.+)$/);
    if (match) {
      meta[match[1] as string] = (match[2] as string).trim();
    }
  }

  if (!meta.name || !meta.type) return null;
  if (!VALID_MEMORY_TYPES.has(meta.type as MemoryType)) return null;

  const frontmatter: MemoryFrontmatter = {
    name: meta.name,
    description: meta.description ?? "",
    type: meta.type as MemoryType,
  };
  if (meta.created_at) frontmatter.created_at = meta.created_at;
  if (meta.updated_at) frontmatter.updated_at = meta.updated_at;
  if (meta.occurred_on) frontmatter.occurred_on = meta.occurred_on;
  return frontmatter;
}

/**
 * Port of stripFrontmatter: returns the body after the closing "---" (trimmed),
 * or the whole content when no valid frontmatter block is present.
 */
export function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;

  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1 || endIndex > MAX_FRONTMATTER_LINES) return content;

  return lines.slice(endIndex + 1).join("\n").trim();
}

/** Split raw content into { frontmatter, body }. null if frontmatter is invalid. */
export function parseDocument(content: string): MemoryDocument | null {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return null;
  return { frontmatter, body: stripFrontmatter(content) };
}

/**
 * Deterministic serializer: "---\n" + ordered keys + "---\n\n" + body + "\n".
 * Key order is fixed: name, description, type, created_at, updated_at, occurred_on.
 * Values must be single-line (multi-line values are rejected upstream).
 */
export function serializeDocument(doc: MemoryDocument): string {
  const fm = doc.frontmatter as unknown as Record<string, string | undefined>;
  const out: string[] = ["---"];
  for (const key of FRONTMATTER_KEY_ORDER) {
    const value = fm[key];
    if (value === undefined || value === null) continue;
    if (key === "description" && value === "") {
      out.push("description: ");
      continue;
    }
    out.push(`${key}: ${value}`);
  }
  out.push("---", "");
  const body = doc.body.replace(/\s+$/, "");
  return `${out.join("\n")}\n${body}\n`;
}

/** True when a frontmatter value would break the single-line "key: value" format. */
export function isSingleLineValue(value: string): boolean {
  return !/[\r\n]/.test(value);
}
