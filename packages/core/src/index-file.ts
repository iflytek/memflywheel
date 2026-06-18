/**
 * MEMORY.md: derived index. Direct port of memory-index.js.
 * MEMORY.md is rebuildable and NEVER authored by the LLM.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { type MemoryEntry, type MemoryType } from "./types.js";
import { scanMemoryFiles } from "./scan.js";
import { atomicWriteFile } from "./atomic.js";

export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25000;
export const INDEX_FILE = "MEMORY.md";

const DAY_MS = 30 * 24 * 60 * 60 * 1000;

export const AGING_THRESHOLDS: Readonly<Record<MemoryType, number | null>> = {
  identity: null,
  preference: null,
  style: null,
  workflow: null,
  context: DAY_MS,
  ambient: DAY_MS,
};

const TRUNCATION_MARKER =
  "<!-- 记忆索引已截断；仅在确实需要查看剩余索引时，才 Read MEMORY.md 文件 -->";

function getEntryPath(entry: MemoryEntry): string {
  return entry?.relativePath || entry?.filename || "";
}

function escapeRegex(text: string): string {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Port of buildMemoryIndexContent. */
export function buildIndexContent(entries: MemoryEntry[]): string {
  if (!entries || entries.length === 0) return "";

  return entries
    .map((entry) => {
      const entryPath = getEntryPath(entry);
      const description = entry.description || "（无描述）";
      // Relative path keeps MEMORY.md portable across machines and checkouts.
      return `- [${entry.name}](${entryPath}) - ${description} (type: ${entry.type}, path: ${entryPath})`;
    })
    .join("\n");
}

/** Port of truncateIndex: cap to 200 lines, then to 25000 UTF-8 bytes. */
export function truncateIndex(content: string): string {
  if (!content) return content;

  let lines = content.split("\n");
  let truncated = false;

  if (lines.length > INDEX_MAX_LINES) {
    lines = lines.slice(0, INDEX_MAX_LINES);
    truncated = true;
  }

  let result = lines.join("\n");
  if (Buffer.byteLength(result, "utf8") > INDEX_MAX_BYTES) {
    while (lines.length > 0 && Buffer.byteLength(lines.join("\n"), "utf8") > INDEX_MAX_BYTES) {
      lines.pop();
    }
    result = lines.join("\n");
    truncated = true;
  }

  if (truncated) {
    result += `\n\n${TRUNCATION_MARKER}`;
  }

  return result;
}

/** Port of applyAgingHints: append a verify hint to aged context/ambient lines. */
export function applyAgingHints(content: string, entries: MemoryEntry[]): string {
  if (!content || !entries || entries.length === 0) return content;

  const now = Date.now();
  let result = content;

  for (const entry of entries) {
    const threshold = AGING_THRESHOLDS[entry.type];
    if (threshold === null || threshold === undefined) continue;

    const age = now - entry.mtime;
    if (age <= threshold) continue;

    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    const hint = `（此记忆已有 ${days} 天未更新，使用前建议验证）`;
    const entryPath = getEntryPath(entry);
    const pathPattern = escapeRegex(entryPath).replace(/\//g, "[\\\\/]");
    const filenamePattern = escapeRegex(entry.filename || path.posix.basename(entryPath));
    const regex = new RegExp(
      `(\\[.*?\\]\\([^\\n)]*(?:${pathPattern}|${filenamePattern})[^\\n)]*\\).*?)$`,
      "m",
    );
    result = result.replace(regex, `$1 ${hint}`);
  }

  return result;
}

/** Read MEMORY.md; "" on ENOENT. */
export async function readMemoryIndex(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, INDEX_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Port of syncMemoryIndex: rebuild MEMORY.md from entries (or a fresh scan) and write it. */
export async function syncMemoryIndex(root: string, entries?: MemoryEntry[]): Promise<string> {
  const nextEntries = entries ?? (await scanMemoryFiles(root));
  const content = buildIndexContent(nextEntries);
  await atomicWriteFile(path.join(root, INDEX_FILE), content);
  return content;
}
