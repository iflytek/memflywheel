/**
 * Extraction kernel: session closure around an injected subagent runner.
 *
 * Core owns the full extraction lifecycle (lock / window / relocate / index /
 * cursor) but NEVER calls an LLM. The actual memory writes are performed by the
 * injected ExtractionAgentRunner, which drives a tool-calling subagent that
 * writes files directly through ordinary file tools.
 */

import { createHash } from "node:crypto";
import {
  readdir,
  stat,
  mkdir,
  rename,
  copyFile,
  unlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import { RESERVED_MEMORY_FILES } from "./types.js";
import { type StorageContext } from "./storage.js";
import { getTypedMemoryPath, normalizeRelativePath } from "./paths.js";
import { readMemoryFrontmatterHeader } from "./internal-frontmatter.js";
import { scanAllMemoryFiles, scanMemoryFiles, formatManifest } from "./scan.js";
import { syncMemoryIndex } from "./index-file.js";
import {
  type FileTool,
  type FileToolContext,
  type MemorySourceRef,
  createFileTools,
  createMemoryFileToolContext,
} from "./file-tools.js";

export const EXTRACTION_CONTEXT_WINDOW_SIZE = 6;
export const EXTRACTION_MAX_MESSAGES = 40;

export enum ExtractionResult {
  Queued = "queued",
  Completed = "completed",
  Skipped = "skipped",
  Failed = "failed",
}

/**
 * One host tool call, folded into the extraction context as text. The host
 * adapter pairs a tool invocation with its result; core renders them as
 * truncated `Tool(name): input` / `Output: output` lines so durable facts that
 * only surface in tool activity (e.g. "this project uses pnpm") are not lost.
 * MemFlywheel cannot fork the host agent (it is an external scribe), so it cannot
 * share the host's structured tool blocks / prompt cache the way an in-host
 * extractor can — instead it folds tool calls into the reconstructed transcript.
 */
export interface ExtractionToolCall {
  /** Tool name, e.g. "Bash", "Read". */
  name: string;
  /** Tool input/arguments (any JSON-serializable value). */
  input?: unknown;
  /** Tool result/output (any JSON-serializable value or string). */
  output?: unknown;
}

export interface ExtractionMessage {
  role: "user" | "assistant";
  text: string;
  /**
   * Host tool calls made on this turn (assistant turns), folded into the
   * extraction context as truncated text. Optional and backward-compatible: a
   * message with no toolCalls renders exactly as before.
   */
  toolCalls?: ExtractionToolCall[];
  /**
   * Absolute time anchor for THIS turn (e.g. "2023-05-08" or an ISO datetime),
   * supplied by the host when the turn's wall-clock time is known. It lets the
   * extractor resolve relative dates in the text ("yesterday", "last week")
   * into an absolute `occurred_on`. Optional and backward-compatible: when
   * absent the message renders exactly as before and no date is ever guessed.
   */
  timestamp?: string;
}

// ---- Tool-call folding (per-field truncation + window-level backstop) ----

/** Max chars of a folded tool INPUT (head-only — the signal is at the front). */
export const TOOL_INPUT_MAX_CHARS = 200;
/** Max chars of a folded tool OUTPUT (head+tail — results/errors cluster at both ends). */
export const TOOL_OUTPUT_MAX_CHARS = 500;
/**
 * Window-level backstop: the TOTAL chars of folded tool text rendered across the
 * whole extraction window. Per-field caps bound each call; this bounds the sum so
 * a turn with very many tool calls cannot blow up the extraction prompt. Tunable.
 */
export const TOOL_FOLD_WINDOW_MAX_CHARS = 4000;
export const SOURCE_TRACE_DIR = ".memflywheel/sources";

function elision(omitted: number): string {
  return `…[${omitted} characters omitted]…`;
}

/** JSON-stringify a tool input/output to a flat string for folding. */
export function foldValueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Head-only truncation: keep the first `max` chars (signal-at-front: commands, paths). */
export function truncateHead(text: string, max: number): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + elision(s.length - max);
}

/** Head+tail truncation: keep ~60% head + ~40% tail with an elision marker between. */
export function truncateHeadTail(text: string, max: number): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return s.slice(0, head) + elision(omitted) + s.slice(s.length - tail);
}

/**
 * THE pluggable injection point. The SDK supplies a tool-calling agent loop
 * here; core calls it inside the held write lock. The runner writes memories
 * itself via the supplied tools (bound to the same context, so they share the
 * lock). Core never calls an LLM — it calls this.
 */
export type ExtractionAgentRunner = (input: {
  toolCtx: FileToolContext;
  tools: FileTool[];
  messages: ExtractionMessage[];
  manifest: string;
  root: string;
}) => Promise<{ changed: string[] }>;

// ---- Message-window selection ----

const PRELUDE_PATTERNS: RegExp[] = [
  /^Before answering the user request/i,
  /^After the skills? are loaded/i,
  /call the skill tool/i,
  /^You are an AI assistant/i,
  /^<system/i,
  /^<command/i,
];

const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;

export function stripSystemReminderBlocks(text: string): string {
  return String(text || "")
    .replace(SYSTEM_REMINDER_BLOCK_RE, "")
    .trim();
}

export function isPreludeText(text: string): boolean {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  return PRELUDE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Strip <system-reminder> blocks + prelude patterns from user turns; keep
 * assistant turns verbatim. Empty user turns are dropped.
 */
export function cleanMessages(messages: ExtractionMessage[]): ExtractionMessage[] {
  const out: ExtractionMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      out.push(m);
      continue;
    }
    const cleaned = stripSystemReminderBlocks(m.text);
    if (!cleaned || isPreludeText(cleaned)) continue;
    const rebuilt: ExtractionMessage = { role: "user", text: cleaned };
    if (m.toolCalls) rebuilt.toolCalls = m.toolCalls;
    if (m.timestamp) rebuilt.timestamp = m.timestamp;
    out.push(rebuilt);
  }
  return out;
}

function sourceFileForSession(sessionId: string): string {
  const hash = createHash("sha256")
    .update(sessionId || "default")
    .digest("hex")
    .slice(0, 16);
  return `${SOURCE_TRACE_DIR}/session-${hash}.jsonl`;
}

function sourceTraceLine(message: ExtractionMessage): string {
  const payload: Record<string, unknown> = {
    role: message.role,
    text: message.text,
  };
  if (message.timestamp) payload.timestamp = message.timestamp;
  if (message.toolCalls && message.toolCalls.length > 0) {
    payload.toolCalls = message.toolCalls.map((call) => ({
      name: call.name,
      input: truncateHead(foldValueToText(call.input), TOOL_INPUT_MAX_CHARS),
      output: truncateHeadTail(foldValueToText(call.output), TOOL_OUTPUT_MAX_CHARS),
    }));
  }
  return JSON.stringify(payload);
}

function countSourceTraceOverlap(existingLines: string[], nextLines: string[]): number {
  const max = Math.min(existingLines.length, nextLines.length);
  for (let size = max; size > 0; size -= 1) {
    const offset = existingLines.length - size;
    if (nextLines.slice(0, size).every((line, index) => line === existingLines[offset + index])) {
      return size;
    }
  }
  return 0;
}

async function appendSourceTrace(
  root: string,
  sessionId: string,
  messages: ExtractionMessage[],
): Promise<MemorySourceRef> {
  const relativePath = sourceFileForSession(sessionId);
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const previous = await readFile(absolutePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const existingLines = previous.trimEnd() ? previous.trimEnd().split(/\r?\n/) : [];
  const lines = messages.map(sourceTraceLine);
  const overlap = countSourceTraceOverlap(existingLines, lines);
  const newLines = lines.slice(overlap);
  const startLine =
    newLines.length > 0 ? existingLines.length + 1 : existingLines.length - overlap + 1;
  const endLine =
    newLines.length > 0 ? existingLines.length + newLines.length : existingLines.length;
  if (newLines.length > 0) {
    const separator = previous && !previous.endsWith("\n") ? "\n" : "";
    await writeFile(absolutePath, `${previous}${separator}${newLines.join("\n")}\n`, "utf8");
  }
  return { relativePath, absolutePath, startLine, endLine };
}

/**
 * Select the message window for extraction (cursor as an index into the array).
 * cursorIndex is the index of the last already-processed message; null = first run.
 */
export function selectMessagesForExtraction(
  messages: ExtractionMessage[],
  cursorIndex: number | null,
): ExtractionMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  if (cursorIndex === null || cursorIndex < 0 || cursorIndex >= messages.length) {
    return messages.slice(-EXTRACTION_MAX_MESSAGES);
  }

  const newMessages = messages.slice(cursorIndex + 1);
  if (newMessages.length === 0) return [];

  if (newMessages.length >= EXTRACTION_MAX_MESSAGES) {
    return newMessages.slice(-EXTRACTION_MAX_MESSAGES);
  }

  const availableContextSize = Math.min(
    EXTRACTION_CONTEXT_WINDOW_SIZE,
    cursorIndex + 1,
    EXTRACTION_MAX_MESSAGES - newMessages.length,
  );
  const contextStart = cursorIndex + 1 - availableContextSize;
  const contextMessages = messages.slice(contextStart, cursorIndex + 1);

  return [...contextMessages, ...newMessages];
}

function selectMessagesForSourceTrace(
  messages: ExtractionMessage[],
  cursorIndex: number | null,
): ExtractionMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  if (cursorIndex === null || cursorIndex < 0 || cursorIndex >= messages.length) {
    return messages.slice(-EXTRACTION_MAX_MESSAGES);
  }

  const newMessages = messages.slice(cursorIndex + 1);
  if (newMessages.length === 0) return [];
  return newMessages.length >= EXTRACTION_MAX_MESSAGES
    ? newMessages.slice(-EXTRACTION_MAX_MESSAGES)
    : newMessages;
}

// ---- Cursor + pending queue ----

export interface CursorStore {
  get(sessionId: string): number | null;
  set(sessionId: string, cursorIndex: number): void;
}

export function createMemoryCursorStore(): CursorStore {
  const cursors = new Map<string, number>();
  return {
    get(sessionId: string): number | null {
      return cursors.has(sessionId) ? (cursors.get(sessionId) as number) : null;
    },
    set(sessionId: string, cursorIndex: number): void {
      cursors.set(sessionId, cursorIndex);
    },
  };
}

// ---- relocateRootFiles ----

/**
 * Move stray root-level *.md into their typed dir based on frontmatter.type.
 * On conflict, keep the newer mtime. Returns moved relativePaths.
 */
export async function relocateRootFiles(ctx: StorageContext): Promise<string[]> {
  const root = ctx.root;
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const moved: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (dirent.name.startsWith(".")) continue;
    if (!dirent.name.endsWith(".md")) continue;
    if (RESERVED_MEMORY_FILES.has(dirent.name)) continue;

    const sourcePath = path.join(root, dirent.name);
    const meta = await readMemoryFrontmatterHeader(sourcePath).catch(() => null);
    if (!meta?.type) continue;

    const targetPath = getTypedMemoryPath(root, meta.type, dirent.name);
    if (!targetPath) continue;

    const targetRel = normalizeRelativePath(path.relative(root, targetPath));
    const sourceStat = await stat(sourcePath);
    await mkdir(path.dirname(targetPath), { recursive: true });

    try {
      const targetStat = await stat(targetPath);
      if (sourceStat.mtimeMs >= targetStat.mtimeMs) {
        await copyFile(sourcePath, targetPath);
        await unlink(sourcePath);
      } else {
        await unlink(sourcePath);
      }
      moved.push(targetRel);
      await ctx.audit.append({ ts: new Date().toISOString(), action: "relocate", path: targetRel });
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    await rename(sourcePath, targetPath);
    moved.push(targetRel);
    await ctx.audit.append({ ts: new Date().toISOString(), action: "relocate", path: targetRel });
  }

  return moved;
}

// ---- Full lifecycle ----

const pendingExtractions = new Map<string, () => Promise<ExtractionResult>>();
let draining = false;

async function drainPending(): Promise<void> {
  if (draining || pendingExtractions.size === 0) return;
  draining = true;
  try {
    while (pendingExtractions.size > 0) {
      const next = pendingExtractions.entries().next().value as
        [string, () => Promise<ExtractionResult>] | undefined;
      if (!next) break;
      const [sessionId, run] = next;
      pendingExtractions.delete(sessionId);
      const result = await run();
      if (result === ExtractionResult.Queued) break;
    }
  } finally {
    draining = false;
  }
}

export interface RunExtractionSessionOptions {
  ctx: StorageContext;
  /** The injected subagent driver (SDK's tool-calling loop). It writes via the tools. */
  agent: ExtractionAgentRunner;
  messages: ExtractionMessage[];
  sessionId: string;
  cursorStore: CursorStore;
  /** Hard secret gate for ordinary file tools. Default OFF (privacy via prompt). */
  refuseSecrets?: boolean;
}

/**
 * Full extraction session closure — core owns everything except the LLM:
 *  1 acquireLock (else enqueue → Queued)
 *  2 relocateRootFiles
 *  3 select window via cursor (over cleaned messages)
 *  4 before = scanMemoryFiles → manifest
 *  5 build ordinary file tools (bound to ctx; they share the held lock) and invoke the
 *    injected agent runner, which writes memories itself via those tools
 *  6 relocateRootFiles again (catch any root-level write the subagent made)
 *  7 after = scanMemoryFiles → syncMemoryIndex
 *  8 advance cursor ONLY on success; stamp .last-extraction
 *  9 releaseLock; drain pending queue
 *
 * A thrown agent runner (e.g. network failure) ⇒ Failed, and the cursor does
 * NOT advance, so the window is retried next turn. Per-tool failures are
 * non-fatal (handlers return results) and simply leave files unchanged.
 */
export async function runExtractionSession(
  opts: RunExtractionSessionOptions,
): Promise<ExtractionResult> {
  const { ctx, agent, messages, sessionId, cursorStore, refuseSecrets } = opts;
  const { acquireLock, releaseLock } = await import("./lock.js");

  const handle = await acquireLock(ctx.root, "extract");
  if (!handle.acquired) {
    pendingExtractions.set(sessionId, () => runExtractionSession(opts));
    return ExtractionResult.Queued;
  }

  try {
    await relocateRootFiles(ctx);

    const cleaned = cleanMessages(messages);
    const cursor = cursorStore.get(sessionId);
    const selected = selectMessagesForExtraction(cleaned, cursor);
    if (selected.length === 0) {
      return ExtractionResult.Skipped;
    }

    const before = await scanMemoryFiles(ctx.root);
    const manifest = formatManifest(before);

    const sourceMessages = selectMessagesForSourceTrace(cleaned, cursor);
    const sourceRef = await appendSourceTrace(ctx.root, sessionId, sourceMessages);
    const toolCtx = createMemoryFileToolContext({ ctx, refuseSecrets, sourceRef });
    const tools = createFileTools();

    try {
      await agent({ toolCtx, tools, messages: selected, manifest, root: ctx.root });
    } catch {
      return ExtractionResult.Failed;
    }

    await relocateRootFiles(ctx);
    const after = await scanMemoryFiles(ctx.root);
    await syncMemoryIndex(ctx.root, await scanAllMemoryFiles(ctx.root));

    // Advance cursor only on success (we did not throw / fail).
    cursorStore.set(sessionId, cleaned.length - 1);
    await writeFile(
      path.join(ctx.root, ".last-extraction"),
      new Date().toISOString(),
      "utf8",
    ).catch(() => {});

    const changedCount = countChanges(before, after);
    return changedCount > 0 ? ExtractionResult.Completed : ExtractionResult.Skipped;
  } finally {
    await releaseLock(ctx.root);
    void drainPending();
  }
}

function countChanges(
  before: { relativePath: string; mtime: number }[],
  after: { relativePath: string; mtime: number }[],
): number {
  const beforeMtimes = new Map(before.map((e) => [e.relativePath, e.mtime]));
  let count = 0;
  for (const e of after) {
    const prev = beforeMtimes.get(e.relativePath);
    if (prev === undefined || e.mtime > prev) count += 1;
  }
  return count;
}
