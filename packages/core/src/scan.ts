/**
 * Filesystem scanning and content aggregation. Direct port of memory-scan.js.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { RESERVED_MEMORY_FILES, type MemoryEntry, type MemoryType } from "./types.js";
import { parseFrontmatter, stripFrontmatter, FRONTMATTER_READ_BYTES } from "./frontmatter.js";
import { memoryTypeForRelativePath, normalizeRelativePath } from "./paths.js";

export const MAX_SCAN_ENTRIES = 200;

async function readFrontmatterHeader(filePath: string): Promise<string> {
  const fd = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(FRONTMATTER_READ_BYTES);
    await fd.read(buf, 0, FRONTMATTER_READ_BYTES, 0);
    return buf.toString("utf8").replace(/\0+$/, "");
  } finally {
    await fd.close();
  }
}

async function walkMemoryFiles(
  memoryRoot: string,
  currentDir: string,
  entries: MemoryEntry[],
): Promise<void> {
  const dirents = await readdir(currentDir, { withFileTypes: true });

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;

    const absolutePath = path.join(currentDir, dirent.name);
    const relativePath = normalizeRelativePath(path.relative(memoryRoot, absolutePath));

    if (dirent.isDirectory()) {
      if (currentDir === memoryRoot && !memoryTypeForRelativePath(relativePath)) continue;
      await walkMemoryFiles(memoryRoot, absolutePath, entries);
      continue;
    }

    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith(".md")) continue;
    if (RESERVED_MEMORY_FILES.has(dirent.name)) continue;
    if (!memoryTypeForRelativePath(relativePath)) continue;

    try {
      const st = await stat(absolutePath);
      if (!st.isFile()) continue;

      const header = await readFrontmatterHeader(absolutePath);
      const meta = parseFrontmatter(header);
      if (!meta) continue;

      entries.push({
        filename: dirent.name,
        relativePath,
        name: meta.name,
        description: meta.description || "",
        type: meta.type,
        occurredOn: meta.occurred_on,
        retrievalTerms: meta.retrieval_terms,
        mtime: st.mtimeMs,
      });
    } catch {
      // Skip unreadable files.
    }
  }
}

async function scanMemoryFilesInternal(root: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];

  try {
    await walkMemoryFiles(root, root, entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/**
 * Recursive scan: skip hidden dirents, *.md only, skip reserved files, parse
 * the frontmatter header, sort by mtime DESC, cap at MAX_SCAN_ENTRIES.
 */
export async function scanMemoryFiles(root: string): Promise<MemoryEntry[]> {
  const entries = await scanMemoryFilesInternal(root);
  return entries.slice(0, MAX_SCAN_ENTRIES);
}

/**
 * Complete recursive scan for rebuildable index/search corpus. Extraction and
 * dream prompt manifests should keep using scanMemoryFiles to cap prompt size.
 */
export async function scanAllMemoryFiles(root: string): Promise<MemoryEntry[]> {
  return scanMemoryFilesInternal(root);
}

/**
 * Port of readAllMemoryContents: concatenated bodies as
 * "### name (type)\n\n<body>" joined by "\n\n---\n\n", capped at maxTotalBytes.
 */
export async function readAllMemoryContents(
  root: string,
  maxTotalBytes = 30 * 1024,
): Promise<string> {
  const entries = await scanMemoryFiles(root);
  if (entries.length === 0) return "";

  const sections: string[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    try {
      const entryPath = entry.relativePath || entry.filename;
      const filePath = path.join(root, entryPath);
      const raw = await readFile(filePath, "utf8");
      const body = stripFrontmatter(raw);
      if (!body) continue;

      const section = `### ${entry.name} (${entry.type})\n\n${body}`;
      const size = Buffer.byteLength(section, "utf8");
      if (totalBytes + size > maxTotalBytes) break;

      totalBytes += size;
      sections.push(section);
    } catch {
      // Skip read errors.
    }
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Port of formatManifest: one line per entry, or "(no existing memories)" when empty.
 * Consumed by extract/dream prompt builders in the host.
 */
export function formatManifest(entries: MemoryEntry[]): string {
  if (!entries || entries.length === 0) return "(no existing memories)";

  return entries
    .map((entry) => {
      const date = new Date(entry.mtime).toISOString().slice(0, 10);
      const entryPath = entry.relativePath || entry.filename;
      const terms = entry.retrievalTerms?.length
        ? `; terms: ${entry.retrievalTerms.join(", ")}`
        : "";
      return `- [${entry.type}] ${entryPath} (${date}): ${entry.description}${terms}`;
    })
    .join("\n");
}

export type { MemoryType };
