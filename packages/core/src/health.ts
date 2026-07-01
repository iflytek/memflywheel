/**
 * Structural health findings used by dream's deterministic planner and host
 * diagnostics.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { RESERVED_MEMORY_FILES, VALID_MEMORY_TYPES } from "./types.js";
import { memoryTypeForRelativePath, normalizeRelativePath } from "./paths.js";
import { scanMemoryFiles } from "./scan.js";

export type HealthCode =
  | "missing-frontmatter"
  | "missing-frontmatter-name"
  | "missing-frontmatter-type"
  | "invalid-frontmatter-type"
  | "path-type-mismatch"
  | "duplicate-name-type"
  | "duplicate-content";

export interface HealthFinding {
  severity: "error" | "warn";
  code: HealthCode;
  paths: string[];
  message: string;
}

export interface TypeReviewItem {
  path: string;
  type: string;
  name: string;
  description: string;
  excerpt: string;
}

function normalizeContent(content: string): string {
  return String(content || "").replace(/\r\n?/g, "\n");
}

function stripLooseFrontmatter(content: string): string {
  const lines = normalizeContent(content).split("\n");
  if (lines[0]?.trim() !== "---") return normalizeContent(content).trim();
  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1 || endIndex > 30) return normalizeContent(content).trim();
  return lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();
}

function normalizeBody(content: string): string {
  return stripLooseFrontmatter(normalizeContent(content))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function summarizeBodyExcerpt(content: string, maxLength = 160): string {
  const normalized = normalizeBody(content).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trim();
}

interface LooseFrontmatter {
  hasFrontmatter: boolean;
  meta: Record<string, string>;
}

function readLooseFrontmatter(content: string): LooseFrontmatter {
  const lines = normalizeContent(content).split("\n");
  if (lines[0]?.trim() !== "---") return { hasFrontmatter: false, meta: {} };
  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1 || endIndex > 30) return { hasFrontmatter: false, meta: {} };

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIndex; i += 1) {
    const match = (lines[i] ?? "").match(/^([^:\s]+):\s*(.+)$/);
    if (match) {
      meta[(match[1] as string).trim()] = (match[2] as string).trim();
    }
  }
  return { hasFrontmatter: true, meta };
}

async function walkMarkdownFiles(root: string, currentDir: string, files: string[]): Promise<void> {
  const dirents = await readdir(currentDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const absolutePath = path.join(currentDir, dirent.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    if (dirent.isDirectory()) {
      if (currentDir === root && !memoryTypeForRelativePath(relativePath)) continue;
      await walkMarkdownFiles(root, absolutePath, files);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith(".md")) continue;
    if (RESERVED_MEMORY_FILES.has(dirent.name)) continue;
    files.push(relativePath);
  }
}

export async function listAllMemoryMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    await walkMarkdownFiles(root, root, files);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function createFinding(
  severity: "error" | "warn",
  code: HealthCode,
  paths: string[],
  message: string,
): HealthFinding {
  return {
    severity,
    code,
    paths: [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    ),
    message,
  };
}

const FINDING_ORDER: Record<HealthCode, number> = {
  "missing-frontmatter": 0,
  "missing-frontmatter-name": 1,
  "missing-frontmatter-type": 2,
  "invalid-frontmatter-type": 3,
  "path-type-mismatch": 4,
  "duplicate-name-type": 5,
  "duplicate-content": 6,
};

/**
 * Validate frontmatter structure/fields/type, check path-vs-type, and detect
 * identity (type::name) and content duplicates. Sorted by code order then path.
 */
export async function buildHealthFindings(root: string): Promise<HealthFinding[]> {
  const files = await listAllMemoryMarkdownFiles(root);
  const entries = await scanMemoryFiles(root);
  const findings: HealthFinding[] = [];

  interface FileInfo {
    relativePath: string;
    hasFrontmatter: boolean;
    name: string;
    type: string;
    normalizedBody: string;
  }
  const fileInfos = new Map<string, FileInfo>();

  for (const relativePath of files) {
    const rawContent = await readFile(path.join(root, relativePath), "utf8");
    const frontmatter = readLooseFrontmatter(rawContent);
    const normalizedBody = normalizeBody(rawContent);
    const type = String(frontmatter.meta.type || "").trim();
    const name = String(frontmatter.meta.name || "").trim();

    fileInfos.set(relativePath, {
      relativePath,
      hasFrontmatter: frontmatter.hasFrontmatter,
      name,
      type,
      normalizedBody,
    });

    if (!frontmatter.hasFrontmatter) {
      findings.push(
        createFinding(
          "error",
          "missing-frontmatter",
          [relativePath],
          "The file is missing valid frontmatter.",
        ),
      );
      continue;
    }
    if (!name) {
      findings.push(
        createFinding(
          "error",
          "missing-frontmatter-name",
          [relativePath],
          "The file frontmatter is missing name.",
        ),
      );
    }
    if (!type) {
      findings.push(
        createFinding(
          "error",
          "missing-frontmatter-type",
          [relativePath],
          "The file frontmatter is missing type.",
        ),
      );
      continue;
    }
    if (!VALID_MEMORY_TYPES.has(type as never)) {
      findings.push(
        createFinding(
          "error",
          "invalid-frontmatter-type",
          [relativePath],
          `The file frontmatter type is invalid: ${type}.`,
        ),
      );
    }
  }

  for (const entry of entries) {
    const relativePath = normalizeRelativePath(entry.relativePath || entry.filename);
    if (!relativePath) continue;
    const declaredType = String(entry.type || "").trim();
    const actualDirectory = relativePath.split("/")[0] || "";
    if (declaredType && actualDirectory && declaredType !== actualDirectory) {
      findings.push(
        createFinding(
          "error",
          "path-type-mismatch",
          [relativePath],
          `The file is under ${actualDirectory}/, but frontmatter.type is ${declaredType}.`,
        ),
      );
    }
  }

  const nameTypeGroups = new Map<string, string[]>();
  const contentGroups = new Map<string, string[]>();

  for (const info of fileInfos.values()) {
    if (info.type && VALID_MEMORY_TYPES.has(info.type as never) && info.name) {
      const key = `${info.type}::${info.name}`;
      const existing = nameTypeGroups.get(key) || [];
      existing.push(info.relativePath);
      nameTypeGroups.set(key, existing);
    }
    if (info.normalizedBody) {
      const existing = contentGroups.get(info.normalizedBody) || [];
      existing.push(info.relativePath);
      contentGroups.set(info.normalizedBody, existing);
    }
  }

  for (const [key, paths] of nameTypeGroups.entries()) {
    if (paths.length < 2) continue;
    const [type, name] = key.split("::");
    findings.push(
      createFinding(
        "warn",
        "duplicate-name-type",
        paths,
        `These files have the same type and name (${type} / ${name}); they are duplicate candidates.`,
      ),
    );
  }

  for (const paths of contentGroups.values()) {
    if (paths.length < 2) continue;
    findings.push(
      createFinding(
        "warn",
        "duplicate-content",
        paths,
        "These files have identical bodies and are exact duplicate candidates.",
      ),
    );
  }

  return findings.sort((a, b) => {
    const orderDiff = FINDING_ORDER[a.code] - FINDING_ORDER[b.code];
    if (orderDiff !== 0) return orderDiff;
    return String(a.paths[0] || "").localeCompare(String(b.paths[0] || ""));
  });
}

/** Build the type-review packet for the dream consolidation subagent. */
export async function buildTypeReviewPacket(root: string): Promise<TypeReviewItem[]> {
  const entries = await scanMemoryFiles(root);
  const packet: TypeReviewItem[] = [];

  for (const entry of entries) {
    const pathValue = normalizeRelativePath(entry.relativePath || entry.filename);
    if (!pathValue) continue;
    let rawContent = "";
    try {
      rawContent = await readFile(path.join(root, pathValue), "utf8");
    } catch {
      continue;
    }
    const frontmatter = readLooseFrontmatter(rawContent);
    const meta = frontmatter.meta;
    packet.push({
      path: pathValue,
      type: String(entry.type || meta.type || "").trim(),
      name: String(entry.name || meta.name || "").trim(),
      description: String(entry.description || meta.description || "").trim(),
      excerpt: summarizeBodyExcerpt(rawContent),
    });
  }

  return packet.sort((a, b) => a.path.localeCompare(b.path));
}
