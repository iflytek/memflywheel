/**
 * Memory write tools: the capabilities a subagent calls to write files directly.
 *
 * Each tool is a JSON-schema descriptor (advertised to the LLM) plus an executor.
 * Every write handler runs the full safety contract: path safety → <private>
 * redaction (always) → optional secret gate (default OFF) → atomic write →
 * audit append → index resync. Handlers NEVER throw into the agent loop —
 * invalid args / refusal / not-found are returned as { ok:false, text } so the
 * subagent can read the failure and adapt.
 *
 * Handlers assume the caller already holds the per-root write lock (the whole
 * extraction session runs under one lock). They do not re-lock.
 */

import { type MemoryType, isMemoryType, VALID_MEMORY_TYPES } from "./types.js";
import {
  type StorageContext,
  writeMemoryDocument,
  archiveMemoryDocument,
  readMemoryDocument,
} from "./storage.js";
import { deriveMemoryFilename, memoryTypeForRelativePath } from "./paths.js";
import { isSingleLineValue } from "./frontmatter.js";
import { scanMemoryFiles } from "./scan.js";
import { syncMemoryIndex } from "./index-file.js";

/** A minimal JSON-schema shape (object schemas with additionalProperties:false). */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export type MemoryToolName =
  | "memory_list"
  | "memory_search"
  | "memory_read"
  | "memory_save"
  | "memory_update"
  | "memory_archive";

export interface MemoryToolContext {
  ctx: StorageContext;
  /**
   * Optional hard-secret gate. Default OFF — privacy leans on the prompt,
   * matching the default prompt-led privacy model. <private> redaction is always on.
   */
  refuseSecrets?: boolean;
}

export interface MemoryToolResult {
  ok: boolean;
  /** Human/agent-readable line fed back as the role:"tool" message content. */
  text: string;
  /** relativePath(s) the call touched, for change accounting. */
  changed?: string[];
}

export interface MemoryTool {
  name: MemoryToolName;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: unknown, toolCtx: MemoryToolContext) => Promise<MemoryToolResult>;
}

const MEMORY_TYPE_ENUM = [...VALID_MEMORY_TYPES] as MemoryType[];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Rebuild the derived index so a subsequent memory_list reflects prior writes. */
async function resyncIndex(ctx: StorageContext): Promise<void> {
  const after = await scanMemoryFiles(ctx.root);
  await syncMemoryIndex(ctx.root, after);
}

// ---- memory_list (read-only) ----

const listTool: MemoryTool = {
  name: "memory_list",
  description:
    "List existing memories so you can decide whether to add a new memory or update an existing one. Optionally filter by type. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: MEMORY_TYPE_ENUM,
        description: "Optional: only list memories of this type.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args, { ctx }) {
    const record = asRecord(args) ?? {};
    const filterType = asString(record["type"]).trim();
    if (filterType && !isMemoryType(filterType)) {
      return { ok: false, text: `invalid type filter: ${filterType}` };
    }

    const entries = await scanMemoryFiles(ctx.root);
    const filtered = filterType ? entries.filter((e) => e.type === filterType) : entries;
    if (filtered.length === 0) {
      return { ok: true, text: "(no existing memories)" };
    }
    const lines = filtered.map((e) => {
      const date = new Date(e.mtime).toISOString().slice(0, 10);
      const desc = e.description ? `: ${e.description}` : "";
      return `- [${e.type}] ${e.relativePath} — ${e.name}${desc} (updated ${date})`;
    });
    return { ok: true, text: lines.join("\n") };
  },
};

// ---- memory_search (read-only: locate existing memories by content) ----

const searchTool: MemoryTool = {
  name: "memory_search",
  description:
    "Search existing memories by keyword over name, description, and body. Returns matching memories (most-relevant first) so you can find the right same-topic file to read and update. Optionally filter by type. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to look for in existing memories." },
      type: {
        type: "string",
        enum: MEMORY_TYPE_ENUM,
        description: "Optional: only search memories of this type.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args, { ctx }) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "memory_search: arguments must be an object" };

    const query = asString(record["query"]).trim();
    if (!query) return { ok: false, text: "memory_search: query is required" };

    const filterType = asString(record["type"]).trim();
    if (filterType && !isMemoryType(filterType)) {
      return { ok: false, text: `memory_search: invalid type filter: ${filterType}` };
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await scanMemoryFiles(ctx.root);
    const scoped = filterType ? entries.filter((e) => e.type === filterType) : entries;

    const scored: { line: string; hits: number; mtime: number }[] = [];
    for (const entry of scoped) {
      const doc = await readMemoryDocument(ctx, entry.relativePath);
      if (!doc) continue;
      const hay = `${doc.frontmatter.name}\n${doc.frontmatter.description ?? ""}\n${doc.body}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t)).length;
      if (hits === 0) continue;
      const desc = entry.description ? `: ${entry.description}` : "";
      scored.push({ line: `- [${entry.type}] ${entry.relativePath} — ${entry.name}${desc}`, hits, mtime: entry.mtime });
    }

    if (scored.length === 0) return { ok: true, text: `(no memories match "${query}")` };
    scored.sort((a, b) => b.hits - a.hits || b.mtime - a.mtime);
    return { ok: true, text: scored.map((s) => s.line).join("\n") };
  },
};

// ---- memory_read (read-only: load one memory's full body) ----

const readTool: MemoryTool = {
  name: "memory_read",
  description:
    "Read one memory's full content (frontmatter + body) by its relative path. Call this BEFORE memory_update so you can edit/append against the real current body instead of overwriting it blindly. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      relativePath: { type: "string", description: 'Existing memory path, e.g. "preference/drinks.md".' },
    },
    required: ["relativePath"],
    additionalProperties: false,
  },
  async handler(args, { ctx }) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "memory_read: arguments must be an object" };

    const relativePath = asString(record["relativePath"]).trim();
    if (!relativePath) return { ok: false, text: "memory_read: relativePath is required" };

    const doc = await readMemoryDocument(ctx, relativePath);
    if (!doc) return { ok: false, text: `memory_read: not found "${relativePath}"` };

    const fm = doc.frontmatter;
    const text = [
      `path: ${relativePath}`,
      `type: ${fm.type}`,
      `name: ${fm.name}`,
      `description: ${fm.description ?? ""}`,
      "",
      doc.body,
    ].join("\n");
    return { ok: true, text };
  },
};

// ---- memory_save (create / overwrite one whole document) ----

const saveTool: MemoryTool = {
  name: "memory_save",
  description:
    "Create or overwrite one memory. Provide type, a single-line name, an optional single-line description, and a body of 1–4 natural-language sentences (never an SOP, numbered list, or template). The file path is derived from the name.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: MEMORY_TYPE_ENUM,
        description: "One of the six memory types.",
      },
      name: { type: "string", description: "Single-line frontmatter title." },
      description: { type: "string", description: "Single-line frontmatter summary." },
      body: {
        type: "string",
        description: "1–4 natural-language sentences; never a numbered list, checklist, template, or SOP.",
      },
    },
    required: ["type", "name", "body"],
    additionalProperties: false,
  },
  async handler(args, { ctx, refuseSecrets }) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "memory_save: arguments must be an object" };

    const type = asString(record["type"]).trim();
    const name = asString(record["name"]).trim();
    const description = asString(record["description"]).trim();
    const body = asString(record["body"]);

    if (!isMemoryType(type)) return { ok: false, text: `memory_save: invalid type "${type}"` };
    if (!name || !isSingleLineValue(name)) {
      return { ok: false, text: "memory_save: name must be a non-empty single-line value" };
    }
    if (description && !isSingleLineValue(description)) {
      return { ok: false, text: "memory_save: description must be single-line" };
    }
    if (!body.trim()) return { ok: false, text: "memory_save: body is empty" };

    const filename = deriveMemoryFilename(name);

    try {
      const relativePath = await writeMemoryDocument(ctx, {
        type,
        filename,
        doc: { frontmatter: { name, description, type }, body },
        refuseSecrets,
      });
      await resyncIndex(ctx);
      return { ok: true, text: `saved ${relativePath}`, changed: [relativePath] };
    } catch (err) {
      return await onWriteError(ctx, err, `${type}/${filename}`);
    }
  },
};

// ---- memory_update (edit an existing file by relative path) ----

const updateTool: MemoryTool = {
  name: "memory_update",
  description:
    "Update an existing memory by its relative path (e.g. \"preference/drinks.md\"). Provide any of name, description, body to override; the type is fixed by the path. Use this to refine a same-topic file instead of creating a near-duplicate.",
  inputSchema: {
    type: "object",
    properties: {
      relativePath: {
        type: "string",
        description: 'Existing memory path, e.g. "preference/drinks.md".',
      },
      name: { type: "string", description: "Single-line frontmatter title (optional override)." },
      description: { type: "string", description: "Single-line frontmatter summary (optional override)." },
      body: { type: "string", description: "Full replacement body (optional)." },
    },
    required: ["relativePath"],
    additionalProperties: false,
  },
  async handler(args, { ctx, refuseSecrets }) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "memory_update: arguments must be an object" };

    const relativePath = asString(record["relativePath"]).trim();
    if (!relativePath) return { ok: false, text: "memory_update: relativePath is required" };

    const type = memoryTypeForRelativePath(relativePath);
    if (!type) return { ok: false, text: `memory_update: cannot resolve type from path "${relativePath}"` };

    const existing = await readMemoryDocument(ctx, relativePath);
    if (!existing) return { ok: false, text: `memory_update: not found "${relativePath}"` };

    const filename = relativePath.split("/").slice(1).join("/") || relativePath;

    const hasName = typeof record["name"] === "string";
    const hasDescription = typeof record["description"] === "string";
    const hasBody = typeof record["body"] === "string";

    const name = hasName ? asString(record["name"]).trim() : existing.frontmatter.name;
    const description = hasDescription
      ? asString(record["description"]).trim()
      : existing.frontmatter.description ?? "";
    const body = hasBody ? asString(record["body"]) : existing.body;

    if (!name || !isSingleLineValue(name)) {
      return { ok: false, text: "memory_update: name must be a non-empty single-line value" };
    }
    if (description && !isSingleLineValue(description)) {
      return { ok: false, text: "memory_update: description must be single-line" };
    }
    if (!body.trim()) return { ok: false, text: "memory_update: body is empty" };

    try {
      const written = await writeMemoryDocument(ctx, {
        type,
        filename,
        doc: { frontmatter: { name, description, type }, body },
        refuseSecrets,
      });
      await resyncIndex(ctx);
      return { ok: true, text: `updated ${written}`, changed: [written] };
    } catch (err) {
      return await onWriteError(ctx, err, relativePath);
    }
  },
};

// ---- memory_archive (retire one file) ----

const archiveTool: MemoryTool = {
  name: "memory_archive",
  description:
    "Archive (retire) one memory by its relative path. Use only when the user explicitly corrects or retracts a prior memory.",
  inputSchema: {
    type: "object",
    properties: {
      relativePath: { type: "string", description: "Existing memory path to archive." },
    },
    required: ["relativePath"],
    additionalProperties: false,
  },
  async handler(args, { ctx }) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "memory_archive: arguments must be an object" };

    const relativePath = asString(record["relativePath"]).trim();
    if (!relativePath) return { ok: false, text: "memory_archive: relativePath is required" };

    const archiveRel = await archiveMemoryDocument(ctx, relativePath).catch(() => null);
    if (!archiveRel) return { ok: false, text: `memory_archive: not found "${relativePath}"` };

    await resyncIndex(ctx);
    return { ok: true, text: `archived ${relativePath} -> ${archiveRel}`, changed: [archiveRel] };
  },
};

async function onWriteError(
  ctx: StorageContext,
  err: unknown,
  pathLabel: string,
): Promise<MemoryToolResult> {
  const name = (err as { name?: string })?.name;
  if (name === "SecretRefusedError") {
    const findings = (err as { findings?: { kind: string }[] }).findings ?? [];
    const kinds = findings.map((f) => f.kind).join(", ");
    await ctx.audit.append({
      ts: new Date().toISOString(),
      action: "secret-refused",
      path: pathLabel,
      detail: kinds,
    });
    return { ok: false, text: `refused: secret (${kinds})` };
  }
  return { ok: false, text: `error: ${String((err as Error)?.message ?? err)}` };
}

/** Build the memory tools (descriptors are stateless; the context is passed per-call).
 * Order: read-only locators (list/search/read) first, then writers (save/update/archive). */
export function createMemoryTools(): MemoryTool[] {
  return [listTool, searchTool, readTool, saveTool, updateTool, archiveTool];
}

/** Lookup map by tool name for the agent loop. */
export function memoryToolMap(tools: MemoryTool[]): Map<string, MemoryTool> {
  return new Map(tools.map((t) => [t.name, t]));
}
