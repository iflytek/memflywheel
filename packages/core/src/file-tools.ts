/**
 * Root-bound file tools for MemScribe subagents.
 *
 * Tool names and parameter shapes follow the ordinary agent file-tool
 * surface: read / write / edit / bash / glob / grep. Memory-specific rules stay
 * in the executor: typed memory writes are parsed, validated, privacy-checked,
 * atomically written, audited, and followed by MEMORY.md index sync.
 */

import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { type AuditLogger } from "./audit.js";
import { atomicWriteFile } from "./atomic.js";
import { isSingleLineValue, parseDocument, serializeDocument } from "./frontmatter.js";
import { syncMemoryIndex } from "./index-file.js";
import { memoryTypeForRelativePath, normalizeRelativePath, resolveRelativePath } from "./paths.js";
import { scanAllMemoryFiles } from "./scan.js";
import { type StorageContext, writeMemoryDocument } from "./storage.js";
import { type MemoryType, RESERVED_MEMORY_FILES } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const GLOB_LIMIT = 100;
const GREP_LIMIT = 100;
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_OUTPUT_CHARS = 64 * 1024;

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export type FileToolName = "read" | "write" | "edit" | "bash" | "glob" | "grep";

export interface FileToolResult {
  ok: boolean;
  text: string;
  changed?: string[];
}

export interface FileToolContext {
  root: string;
  audit?: AuditLogger;
  mode?: "memory" | "files";
  refuseSecrets?: boolean;
  sourceRef?: MemorySourceRef;
  afterMutation?: () => Promise<void>;
}

export interface MemorySourceRef {
  relativePath: string;
  startLine: number;
  endLine: number;
}

export interface FileTool {
  name: FileToolName;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: unknown, toolCtx: FileToolContext) => Promise<FileToolResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function normalizePositiveInt(value: unknown, fallback: number, label: string): number {
  const next = asNumber(value);
  if (next === undefined) return fallback;
  if (next < 1) throw new Error(`${label} must be greater than or equal to 1`);
  return Math.trunc(next);
}

function normalizeTimeout(value: unknown): number {
  const next = asNumber(value);
  if (next === undefined) return BASH_DEFAULT_TIMEOUT_MS;
  if (next < 0) throw new Error(`Invalid timeout value: ${next}. Timeout must be a positive number.`);
  return Math.trunc(next);
}

function resolveUnderRoot(root: string, rawPath: string, label: string): { relativePath: string; absolutePath: string } {
  const inputPath = String(rawPath || "").trim();
  if (!inputPath) throw new Error(`${label} is required`);
  if (inputPath.includes("\0")) throw new Error(`${label} must not contain NUL`);

  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, inputPath);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`${label} escapes tool root: ${inputPath}`);
  }

  const relativePath = normalizeRelativePath(path.relative(resolvedRoot, absolutePath));
  if (!relativePath || relativePath === ".") {
    throw new Error(`${label} must target a path under the tool root`);
  }
  const checked = resolveRelativePath(root, relativePath);
  if (!checked) throw new Error(`${label} escapes tool root: ${inputPath}`);
  return { relativePath, absolutePath: checked };
}

function resolveDirectory(root: string, rawPath?: string): { relativePath: string; absolutePath: string } {
  if (!rawPath || !String(rawPath).trim()) {
    return { relativePath: ".", absolutePath: path.resolve(root) };
  }
  return resolveUnderRoot(root, rawPath, "path");
}

async function statSafe(absolutePath: string) {
  return lstat(absolutePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

async function afterMutation(toolCtx: FileToolContext): Promise<void> {
  if (toolCtx.afterMutation) await toolCtx.afterMutation();
}

function storageCtx(toolCtx: FileToolContext): StorageContext {
  if (!toolCtx.audit) throw new Error("memory file tools require an audit logger");
  return { root: toolCtx.root, audit: toolCtx.audit };
}

function parseMemoryWritePath(relativePath: string): { type: MemoryType; filename: string } {
  const normalized = normalizeRelativePath(relativePath);
  if (RESERVED_MEMORY_FILES.has(path.posix.basename(normalized))) {
    throw new Error(`memory index/control files are not writable by agents: ${normalized}`);
  }
  const type = memoryTypeForRelativePath(normalized);
  if (!type) throw new Error(`memory writes must target a typed memory path: ${normalized}`);
  const filename = normalized.split("/").slice(1).join("/");
  if (!filename || filename.includes("/")) {
    throw new Error(`memory writes must target a flat typed Markdown file: ${normalized}`);
  }
  if (!filename.endsWith(".md")) throw new Error(`memory writes must target Markdown files: ${normalized}`);
  return { type, filename };
}

function formatSourceRef(ref: MemorySourceRef): string {
  return `${ref.relativePath}#L${ref.startLine}-L${ref.endLine}`;
}

function validateRetrievalTerms(terms: string[] | undefined): void {
  if (terms === undefined) return;
  if (!Array.isArray(terms)) throw new Error("frontmatter.retrieval_terms must be a YAML string list");
  if (terms.length > 12) throw new Error("frontmatter.retrieval_terms must contain at most 12 items");
  for (const term of terms) {
    if (!term || !isSingleLineValue(term) || term.length > 80) {
      throw new Error("frontmatter.retrieval_terms items must be non-empty single-line values up to 80 chars");
    }
  }
}

function appendSourceRef(body: string, ref: MemorySourceRef | undefined): string {
  if (!ref) return body;
  const sourceLine = `- ${formatSourceRef(ref)}`;
  const trimmed = body.trimEnd();
  if (trimmed.includes(sourceLine)) return trimmed;
  if (/(^|\n)## Sources\n/.test(trimmed)) {
    return `${trimmed}\n${sourceLine}`;
  }
  return `${trimmed}\n\n## Sources\n\n${sourceLine}`;
}

async function writeByPolicy(toolCtx: FileToolContext, rawPath: string, content: string): Promise<FileToolResult> {
  const { relativePath, absolutePath } = resolveUnderRoot(toolCtx.root, rawPath, "filePath");
  if (toolCtx.mode === "memory") {
    const { type, filename } = parseMemoryWritePath(relativePath);
    const doc = parseDocument(content);
    if (!doc) throw new Error("memory file content must include valid YAML frontmatter");
    if (doc.frontmatter.type !== type) {
      throw new Error(`frontmatter.type must match path type "${type}"`);
    }
    if (!doc.frontmatter.name || !isSingleLineValue(doc.frontmatter.name)) {
      throw new Error("frontmatter.name must be a non-empty single-line value");
    }
    if (!isSingleLineValue(doc.frontmatter.description ?? "")) {
      throw new Error("frontmatter.description must be single-line");
    }
    validateRetrievalTerms(doc.frontmatter.retrieval_terms);
    if (!doc.body.trim()) throw new Error("memory body is empty");
    const docWithSource = {
      ...doc,
      body: appendSourceRef(doc.body, toolCtx.sourceRef),
    };

    const written = await writeMemoryDocument(storageCtx(toolCtx), {
      type,
      filename,
      doc: docWithSource,
      refuseSecrets: toolCtx.refuseSecrets,
    });
    await afterMutation(toolCtx);
    return { ok: true, text: `Wrote file successfully: ${written}`, changed: [written] };
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await atomicWriteFile(absolutePath, content);
  if (toolCtx.audit) {
    await toolCtx.audit.append({ ts: new Date().toISOString(), action: "write", path: relativePath });
  }
  await afterMutation(toolCtx);
  return { ok: true, text: "Wrote file successfully.", changed: [relativePath] };
}

function formatFileLines(content: string, offset: number, limit: number): string {
  const lines = content.split(/\r?\n/);
  const start = offset - 1;
  if (start >= lines.length && !(lines.length === 1 && lines[0] === "" && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines)`);
  }
  const selected = lines.slice(start, start + limit);
  const out = selected.map((line, index) => {
    const text = line.length > MAX_LINE_LENGTH
      ? `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`
      : line;
    return `${start + index + 1}: ${text}`;
  });
  if (start + selected.length < lines.length) {
    out.push(`(Showing ${selected.length} of ${lines.length} lines. Use offset=${start + selected.length + 1} to read more.)`);
  }
  return out.join("\n");
}

async function listDirectory(absolutePath: string, offset: number, limit: number): Promise<string> {
  const entries = (await readdir(absolutePath, { withFileTypes: true }))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((a, b) => a.localeCompare(b));
  const start = offset - 1;
  const sliced = entries.slice(start, start + limit);
  const out = [...sliced];
  out.push(
    start + sliced.length < entries.length
      ? `(Showing ${sliced.length} of ${entries.length} entries. Use offset=${offset + sliced.length} to read more.)`
      : `(${entries.length} entries)`,
  );
  return out.join("\n");
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function convertLineEnding(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function replaceContent(current: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString === newString) throw new Error("No changes to apply: oldString and newString are identical.");
  if (oldString === "") return newString;
  const ending = detectLineEnding(current);
  const oldNeedle = convertLineEnding(normalizeLineEndings(oldString), ending);
  const replacement = convertLineEnding(normalizeLineEndings(newString), ending);
  const hits = current.split(oldNeedle).length - 1;
  if (hits === 0) throw new Error("oldString not found in content");
  if (hits > 1 && !replaceAll) {
    throw new Error("Found multiple matches for oldString. Provide more surrounding lines or set replaceAll=true.");
  }
  return replaceAll ? current.split(oldNeedle).join(replacement) : current.replace(oldNeedle, replacement);
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeRelativePath(pattern || "**/*");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i] ?? "";
    const next = normalized[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegexChar(ch);
    }
  }
  return new RegExp(`${out}$`);
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        out.push(normalizeRelativePath(path.relative(root, absolutePath)));
      }
    }
  }
  await walk(root);
  return out;
}

async function fileMtime(absolutePath: string): Promise<number> {
  return (await statSafe(absolutePath))?.mtimeMs ?? 0;
}

function outputPath(root: string, absolutePath: string): string {
  return path.resolve(absolutePath).startsWith(path.resolve(root) + path.sep) || path.resolve(absolutePath) === path.resolve(root)
    ? path.resolve(absolutePath)
    : absolutePath;
}

function truncateBashOutput(text: string): string {
  if (text.length <= BASH_MAX_OUTPUT_CHARS) return text;
  return `...output truncated...\n\n${text.slice(text.length - BASH_MAX_OUTPUT_CHARS)}`;
}

function errorResult(tool: string, error: unknown): FileToolResult {
  return { ok: false, text: `${tool}: ${String((error as Error)?.message ?? error)}` };
}

const readTool: FileTool = {
  name: "read",
  description: "Read a file or directory. filePath may be absolute or relative to the tool root. Supports offset and limit.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path, or path relative to the tool root." },
      offset: { type: "number", description: "Line or directory-entry offset, 1-indexed." },
      limit: { type: "number", description: "Maximum lines or directory entries to read. Defaults to 2000." },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  async handler(args, toolCtx) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "read: arguments must be an object" };
    try {
      const { absolutePath } = resolveUnderRoot(toolCtx.root, asString(record.filePath), "filePath");
      const offset = normalizePositiveInt(record.offset, 1, "offset");
      const limit = normalizePositiveInt(record.limit, DEFAULT_READ_LIMIT, "limit");
      const stat = await statSafe(absolutePath);
      if (!stat) return { ok: false, text: `File not found: ${absolutePath}` };
      if (stat.isDirectory()) return { ok: true, text: await listDirectory(absolutePath, offset, limit) };
      if (!stat.isFile()) return { ok: false, text: `Path is not a regular file: ${absolutePath}` };
      return { ok: true, text: formatFileLines(await readFile(absolutePath, "utf8"), offset, limit) };
    } catch (error) {
      return errorResult("read", error);
    }
  },
};

const writeTool: FileTool = {
  name: "write",
  description: "Write a file. filePath may be absolute or relative to the tool root. Existing files are overwritten.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path, or path relative to the tool root." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["filePath", "content"],
    additionalProperties: false,
  },
  async handler(args, toolCtx) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "write: arguments must be an object" };
    try {
      return await writeByPolicy(toolCtx, asString(record.filePath), asString(record.content));
    } catch (error) {
      return errorResult("write", error);
    }
  },
};

const editTool: FileTool = {
  name: "edit",
  description: "Perform exact string replacement in a file. oldString=\"\" writes newString as the full file content.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path, or path relative to the tool root." },
      oldString: { type: "string", description: "Exact string to replace. Empty string means write a whole file." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace all occurrences. Defaults to false." },
    },
    required: ["filePath", "oldString", "newString"],
    additionalProperties: false,
  },
  async handler(args, toolCtx) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "edit: arguments must be an object" };
    try {
      const filePath = asString(record.filePath);
      const { absolutePath } = resolveUnderRoot(toolCtx.root, filePath, "filePath");
      const oldString = asString(record.oldString);
      const newString = asString(record.newString);
      const current = oldString === ""
        ? (await readFile(absolutePath, "utf8").catch(() => ""))
        : await readFile(absolutePath, "utf8");
      const next = replaceContent(current, oldString, newString, record.replaceAll === true);
      return await writeByPolicy(toolCtx, filePath, next);
    } catch (error) {
      return errorResult("edit", error);
    }
  },
};

const bashTool: FileTool = {
  name: "bash",
  description: "Run a shell command from the tool root, with optional workdir, timeout, and description.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      workdir: { type: "string", description: "Optional working directory under the tool root." },
      timeout: { type: "number", description: "Timeout in milliseconds. Defaults to 120000." },
      description: { type: "string", description: "Short description of the command." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async handler(args, toolCtx) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "bash: arguments must be an object" };
    try {
      const command = asString(record.command).trim();
      if (!command) return { ok: false, text: "bash: command is required" };
      const workdir = resolveDirectory(toolCtx.root, asString(record.workdir));
      const timeout = normalizeTimeout(record.timeout);
      const result = await execFileAsync("/bin/sh", ["-lc", command], {
        cwd: workdir.absolutePath,
        timeout,
        maxBuffer: 1024 * 1024,
      });
      if (toolCtx.audit) {
        await toolCtx.audit.append({
          ts: new Date().toISOString(),
          action: "write",
          path: workdir.relativePath,
          detail: asString(record.description).trim() || command,
        });
      }
      await afterMutation(toolCtx);
      const text = [result.stdout, result.stderr].map((item) => String(item || "").trimEnd()).filter(Boolean).join("\n");
      return { ok: true, text: truncateBashOutput(text || "(no output)") };
    } catch (error) {
      const err = error as { stdout?: unknown; stderr?: unknown; message?: string };
      const text = [err.stdout, err.stderr, err.message].map((item) => String(item || "").trimEnd()).filter(Boolean).join("\n");
      return { ok: false, text: `bash: ${truncateBashOutput(text)}` };
    }
  },
};

const globTool: FileTool = {
  name: "glob",
  description: "Match files by glob pattern. Supports optional path directory. Results are sorted by modification time.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.md".' },
      path: { type: "string", description: "Optional directory under the tool root. Defaults to the tool root." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async handler(args, toolCtx) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "glob: arguments must be an object" };
    try {
      const pattern = asString(record.pattern).trim();
      if (!pattern) return { ok: false, text: "glob: pattern is required" };
      const search = resolveDirectory(toolCtx.root, asString(record.path));
      const stat = await statSafe(search.absolutePath);
      if (stat?.isFile()) throw new Error(`glob path must be a directory: ${search.absolutePath}`);
      const re = globToRegExp(pattern);
      const matches = await Promise.all(
        (await listFiles(search.absolutePath))
          .filter((file) => re.test(file))
          .map(async (file) => ({
            path: path.resolve(search.absolutePath, file),
            mtime: await fileMtime(path.resolve(search.absolutePath, file)),
          })),
      );
      matches.sort((a, b) => b.mtime - a.mtime);
      const truncated = matches.length > GLOB_LIMIT;
      const final = truncated ? matches.slice(0, GLOB_LIMIT) : matches;
      if (final.length === 0) return { ok: true, text: "No files found" };
      const out = final.map((item) => outputPath(toolCtx.root, item.path));
      if (truncated) out.push("", `(Results are truncated: showing first ${GLOB_LIMIT} results. Consider using a more specific path or pattern.)`);
      return { ok: true, text: out.join("\n") };
    } catch (error) {
      return errorResult("glob", error);
    }
  },
};

const grepTool: FileTool = {
  name: "grep",
  description: "Search file contents using a regular expression. Supports optional path and include glob.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern to search for." },
      path: { type: "string", description: "Optional file or directory under the tool root. Defaults to the tool root." },
      include: { type: "string", description: 'Optional file pattern, e.g. "*.ts" or "**/*.md".' },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async handler(args, toolCtx) {
    const record = asRecord(args);
    if (!record) return { ok: false, text: "grep: arguments must be an object" };
    try {
      const pattern = asString(record.pattern);
      if (!pattern) return { ok: false, text: "grep: pattern is required" };
      const search = resolveDirectory(toolCtx.root, asString(record.path));
      const searchStat = await statSafe(search.absolutePath);
      const cwd = searchStat?.isFile() ? path.dirname(search.absolutePath) : search.absolutePath;
      const candidates = searchStat?.isFile()
        ? [path.basename(search.absolutePath)]
        : await listFiles(cwd);
      const include = asString(record.include).trim();
      const includeRe = include ? globToRegExp(include) : null;
      const regex = new RegExp(pattern, "i");
      const rows: Array<{ file: string; line: number; text: string; mtime: number }> = [];
      for (const file of candidates) {
        if (includeRe && !includeRe.test(file)) continue;
        const absolutePath = path.resolve(cwd, file);
        if (!absolutePath.startsWith(path.resolve(toolCtx.root) + path.sep) && absolutePath !== path.resolve(toolCtx.root)) continue;
        let text: string;
        try {
          text = await readFile(absolutePath, "utf8");
        } catch {
          continue;
        }
        const mtime = await fileMtime(absolutePath);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (regex.test(lines[i] ?? "")) rows.push({ file: absolutePath, line: i + 1, text: lines[i] ?? "", mtime });
        }
      }
      rows.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file) || a.line - b.line);
      if (rows.length === 0) return { ok: true, text: "No files found" };
      const truncated = rows.length > GREP_LIMIT;
      const final = truncated ? rows.slice(0, GREP_LIMIT) : rows;
      const out = [`Found ${rows.length} matches${truncated ? ` (showing first ${GREP_LIMIT})` : ""}`];
      let current = "";
      for (const row of final) {
        const fileLabel = outputPath(toolCtx.root, row.file);
        if (fileLabel !== current) {
          if (current) out.push("");
          current = fileLabel;
          out.push(`${fileLabel}:`);
        }
        const line = row.text.length > MAX_LINE_LENGTH ? `${row.text.slice(0, MAX_LINE_LENGTH)}...` : row.text;
        out.push(`  Line ${row.line}: ${line}`);
      }
      if (truncated) out.push("", `(Results truncated: showing ${GREP_LIMIT} of ${rows.length} matches (${rows.length - GREP_LIMIT} hidden). Consider using a more specific path or pattern.)`);
      return { ok: true, text: out.join("\n") };
    } catch (error) {
      return errorResult("grep", error);
    }
  },
};

export function createFileTools(): FileTool[] {
  return [readTool, writeTool, editTool, bashTool, globTool, grepTool];
}

export function fileToolMap(tools: FileTool[]): Map<string, FileTool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function createMemoryFileToolContext(input: {
  ctx: StorageContext;
  refuseSecrets?: boolean;
  sourceRef?: MemorySourceRef;
}): FileToolContext {
  return {
    root: input.ctx.root,
    audit: input.ctx.audit,
    mode: "memory",
    refuseSecrets: input.refuseSecrets,
    sourceRef: input.sourceRef,
    afterMutation: async () => {
      const entries = await scanAllMemoryFiles(input.ctx.root);
      await syncMemoryIndex(input.ctx.root, entries);
    },
  };
}

export function serializeMemoryFile(input: {
  type: MemoryType;
  name: string;
  description?: string;
  body: string;
}): string {
  return serializeDocument({
    frontmatter: {
      type: input.type,
      name: input.name,
      description: input.description ?? "",
    },
    body: input.body,
  });
}
