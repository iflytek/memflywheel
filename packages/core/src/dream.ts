/**
 * Dream consolidation: a deterministic structural pre-pass + a tool-calling
 * consolidation subagent.
 *
 * Two phases, mirroring extraction's "subagent writes files directly" model:
 *  1. Deterministic pre-pass (no LLM): the unambiguous structural fixes —
 *     identical-body duplicates are removed, files sitting in the wrong type
 *     directory are relocated. Safe, fast, and LLM-free (the CLI's
 *     `dream plan`/`dream apply` run exactly this).
 *  2. Semantic consolidation (subagent): the injected DreamAgentRunner reads the
 *     health / type-review packets, READS FULL BODIES, and merges / compresses /
 *     retires memories by calling the same ordinary file tools the extraction subagent
 *     uses. It never authors a merged body from a truncated excerpt — it reads
 *     first, exactly as read-before-update protects list-type appends.
 *
 * `runDreamSession` owns the session closure: it holds the per-root write lock
 * across both phases, applies the deterministic ops, invokes the subagent under
 * the same lock, relocates stray root files, and resyncs the index.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

import { type MemoryEntry, type MemoryType } from "./types.js";
import {
  type StorageContext,
  readMemoryDocument,
  writeMemoryDocument,
  deleteMemoryDocument,
} from "./storage.js";
import { normalizeRelativePath, ensureMemoryDir } from "./paths.js";
import { scanMemoryFiles, formatManifest } from "./scan.js";
import { syncMemoryIndex, readMemoryIndex } from "./index-file.js";
import { buildHealthFindings, buildTypeReviewPacket, type HealthFinding, type TypeReviewItem } from "./health.js";
import { relocateRootFiles } from "./extract.js";
import { type FileTool, type FileToolContext, createFileTools, createMemoryFileToolContext } from "./file-tools.js";
import { markDreamConsolidated } from "./dream-state.js";

export const DREAM_DEFAULT_MIN_HOURS = 24;
export const DREAM_DEFAULT_MIN_SESSIONS = 5;

/**
 * The deterministic, LLM-free structural ops. Only the two unambiguous fixes:
 * remove an identical-body duplicate, or relocate a file to its declared type's
 * directory. Everything that needs semantics (near-duplicate merges, compression,
 * type re-judgement) is the subagent's job, via ordinary file tools.
 */
export type DreamOp =
  | { kind: "delete-duplicate"; path: string }
  | { kind: "relocate"; path: string; toType: MemoryType };

/** A consolidation directive a host can pass to bias the subagent (optional). */
export interface DreamCoordination {
  reason: string;
  memoryAction: string;
  topics: string[];
  targetSkill?: string;
}

/**
 * THE pluggable dream injection point — symmetric to ExtractionAgentRunner. The
 * subagent receives the structural packets plus the bound ordinary file tools/context
 * (sharing the held write lock) and consolidates by calling those tools
 * directly. It returns the union of relative paths it changed.
 */
export type DreamAgentRunner = (input: {
  root: string;
  toolCtx: FileToolContext;
  tools: FileTool[];
  health: HealthFinding[];
  typeReview: TypeReviewItem[];
  manifest: string;
  index: string;
  coordination?: DreamCoordination;
}) => Promise<{ changed: string[] }>;

/**
 * Deterministic plan (no LLM): derive safe ops from health findings.
 *  - duplicate-content → delete all but the first (sorted) path
 *  - path-type-mismatch → relocate the file to its declared type
 * (Near-duplicate merges / type re-judgement are the subagent's job — they need
 * semantics.)
 */
export async function planDeterministic(
  root: string,
  entries: MemoryEntry[],
): Promise<DreamOp[]> {
  const findings = await buildHealthFindings(root);
  const ops: DreamOp[] = [];
  const deletedDup = new Set<string>();

  for (const finding of findings) {
    if (finding.code === "duplicate-content") {
      const [keep, ...rest] = finding.paths;
      void keep;
      for (const p of rest) {
        if (deletedDup.has(p)) continue;
        deletedDup.add(p);
        ops.push({ kind: "delete-duplicate", path: p });
      }
    } else if (finding.code === "path-type-mismatch") {
      for (const p of finding.paths) {
        const entry = entries.find((e) => e.relativePath === p);
        if (entry) {
          ops.push({ kind: "relocate", path: p, toType: entry.type });
        }
      }
    }
  }

  return ops;
}

/** The deterministic plan for a root. The CLI's `dream plan` prints this. */
export async function planDream(opts: { root: string }): Promise<DreamOp[]> {
  const entries = await scanMemoryFiles(opts.root);
  return planDeterministic(opts.root, entries);
}

export interface ApplyDreamResult {
  changed: string[];
  deleted: string[];
}

function filenameOf(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

/** Apply the deterministic ops in place (no index resync — the caller does it). */
async function applyDreamOps(ctx: StorageContext, ops: DreamOp[]): Promise<ApplyDreamResult> {
  const changed = new Set<string>();
  const deleted = new Set<string>();

  for (const op of ops) {
    switch (op.kind) {
      case "delete-duplicate": {
        const ok = await deleteMemoryDocument(ctx, op.path);
        if (ok) deleted.add(normalizeRelativePath(op.path));
        break;
      }
      case "relocate": {
        const doc = await readMemoryDocument(ctx, op.path);
        if (!doc) break;
        await deleteMemoryDocument(ctx, op.path);
        const rel = await writeMemoryDocument(ctx, {
          type: op.toType,
          filename: filenameOf(op.path),
          doc: { frontmatter: { ...doc.frontmatter, type: op.toType }, body: doc.body },
        });
        deleted.add(normalizeRelativePath(op.path));
        changed.add(rel);
        break;
      }
    }
  }

  return { changed: [...changed], deleted: [...deleted] };
}

/**
 * Apply a deterministic plan, then relocate stray root files and resync the
 * index. The CLI's `dream apply` is exactly this (no subagent).
 */
export async function applyDream(opts: {
  ctx: StorageContext;
  plan: DreamOp[];
}): Promise<ApplyDreamResult> {
  const { ctx, plan } = opts;
  const result = await applyDreamOps(ctx, plan);

  await ctx.audit.append({
    ts: new Date().toISOString(),
    action: "dream-apply",
    detail: `changed=${result.changed.length} deleted=${result.deleted.length}`,
  });

  await relocateRootFiles(ctx);
  const after = await scanMemoryFiles(ctx.root);
  await syncMemoryIndex(ctx.root, after);

  return result;
}

/** Options for {@link runDreamSession}. */
export interface RunDreamSessionOptions {
  ctx: StorageContext;
  /** The semantic-consolidation subagent. When absent, only the deterministic pre-pass runs. */
  runner?: DreamAgentRunner;
  /** Optional host directive biasing the subagent (e.g. compress-memory for a topic). */
  coordination?: DreamCoordination;
  /** Hard secret gate for ordinary file tools. Default OFF. */
  refuseSecrets?: boolean;
}

/** Outcome of a dream pass. */
export interface DreamSessionResult {
  ran: boolean;
  /** "ok" | "locked" | "runner-failed". */
  reason: string;
  /** The deterministic ops applied in the pre-pass. */
  deterministic: DreamOp[];
  /** Union of relative paths changed across both phases. */
  changed: string[];
  /** Relative paths deleted by the deterministic pre-pass. */
  deleted: string[];
}

/**
 * Run a full dream pass under the held write lock: deterministic structural
 * pre-pass, then (if a runner is provided) the consolidation subagent over the
 * cleaned state, then relocate stray root files and resync the index. The
 * subagent shares this lock, so its tool writes are serialized with everything
 * else touching the store.
 */
export async function runDreamSession(opts: RunDreamSessionOptions): Promise<DreamSessionResult> {
  const { ctx, runner, coordination, refuseSecrets } = opts;
  const { acquireLock, releaseLock } = await import("./lock.js");

  const handle = await acquireLock(ctx.root, "dream");
  if (!handle.acquired) {
    return { ran: false, reason: "locked", deterministic: [], changed: [], deleted: [] };
  }

  try {
    await ensureMemoryDir(ctx.root);

    // Phase 1 — deterministic structural pre-pass.
    const before = await scanMemoryFiles(ctx.root);
    const deterministic = await planDeterministic(ctx.root, before);
    const applied = await applyDreamOps(ctx, deterministic);

    // Phase 2 — semantic consolidation subagent over the cleaned state.
    let reason = "ok";
    const runnerChanged: string[] = [];
    if (runner) {
      const cleaned = await scanMemoryFiles(ctx.root);
      const health = await buildHealthFindings(ctx.root);
      const typeReview = await buildTypeReviewPacket(ctx.root);
      const manifest = formatManifest(cleaned);
      const index = await readMemoryIndex(ctx.root);
      const toolCtx = createMemoryFileToolContext({ ctx, refuseSecrets });
      const tools = createFileTools();
      try {
        const result = await runner({
          root: ctx.root,
          toolCtx,
          tools,
          health,
          typeReview,
          manifest,
          index,
          coordination,
        });
        if (result?.changed?.length) runnerChanged.push(...result.changed);
      } catch {
        reason = "runner-failed";
      }
    }

    await ctx.audit.append({
      ts: new Date().toISOString(),
      action: "dream-apply",
      detail: `deterministic=${deterministic.length} changed=${applied.changed.length + runnerChanged.length} deleted=${applied.deleted.length}`,
    });

    await relocateRootFiles(ctx);
    const after = await scanMemoryFiles(ctx.root);
    await syncMemoryIndex(ctx.root, after);

    // Advance the gate ONLY on a successful pass. A runner-failed pass leaves the
    // gate where it was, so the next idle tick retries promptly instead of being
    // suppressed for a full time/session window; the deterministic pre-pass is
    // idempotent, so re-running it costs nothing. (A pass that ran the subagent
    // and simply made no changes is still reason "ok" and advances the gate.)
    if (reason === "ok") {
      await markDreamConsolidated(ctx.root, Date.now());
    }

    return {
      ran: true,
      reason,
      deterministic,
      changed: [...new Set([...applied.changed, ...runnerChanged])],
      deleted: applied.deleted,
    };
  } finally {
    await releaseLock(ctx.root);
  }
}

/** Gate check for auto-dream: time threshold OR session-count threshold (or force). */
export function shouldRunDream(input: {
  now?: number;
  lastConsolidatedAt: number | null;
  candidateSessionCount: number;
  minHours?: number;
  minSessions?: number;
  force?: boolean;
}): boolean {
  if (input.force) return true;
  const minHours = input.minHours ?? DREAM_DEFAULT_MIN_HOURS;
  const minSessions = input.minSessions ?? DREAM_DEFAULT_MIN_SESSIONS;
  const now = input.now ?? Date.now();

  const timeSatisfied =
    input.lastConsolidatedAt !== null &&
    now - input.lastConsolidatedAt >= minHours * 60 * 60 * 1000;
  const sessionSatisfied = input.candidateSessionCount >= minSessions;
  return timeSatisfied || sessionSatisfied;
}

/** Convenience: read raw file content for a relativePath (used by tests/hosts). */
export async function readRawMemory(root: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch {
    return null;
  }
}
