/**
 * Per-root dream gate bookkeeping (.dream-state.json).
 *
 * The dream gate (shouldRunDream) needs "time since last consolidation" and a
 * "candidate session count" to fire on its own. Hosts rarely thread those
 * through their idle ticks, so the scribe keeps them here: bumped as sessions end,
 * read into the gate as defaults, and reset whenever a dream pass actually runs.
 *
 * The dot-prefixed filename keeps this file out of scanMemoryFiles / health / the
 * index (both directory walkers skip dot-prefixed entries and non-.md files).
 * Reads are total: a missing or corrupt file yields the zero state.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "./atomic.js";
import { ensureMemoryDir } from "./paths.js";

export const DREAM_STATE_FILE = ".dream-state.json";

export interface DreamState {
  /** Epoch ms of the last completed dream pass, or null if never. */
  lastConsolidatedAt: number | null;
  /** Sessions ended since the last dream pass. */
  sessionsSince: number;
}

const ZERO_STATE: DreamState = { lastConsolidatedAt: null, sessionsSince: 0 };

function coerce(raw: unknown): DreamState {
  if (!raw || typeof raw !== "object") return { ...ZERO_STATE };
  const r = raw as Record<string, unknown>;
  const last =
    typeof r.lastConsolidatedAt === "number" && Number.isFinite(r.lastConsolidatedAt)
      ? r.lastConsolidatedAt
      : null;
  const since =
    typeof r.sessionsSince === "number" && Number.isFinite(r.sessionsSince) && r.sessionsSince > 0
      ? Math.trunc(r.sessionsSince)
      : 0;
  return { lastConsolidatedAt: last, sessionsSince: since };
}

/** Read the dream state. Total: a missing or corrupt file yields the zero state. */
export async function readDreamState(root: string): Promise<DreamState> {
  try {
    const raw = await readFile(path.join(root, DREAM_STATE_FILE), "utf8");
    return coerce(JSON.parse(raw));
  } catch {
    return { ...ZERO_STATE };
  }
}

async function writeDreamState(root: string, state: DreamState): Promise<void> {
  await ensureMemoryDir(root);
  await atomicWriteFile(path.join(root, DREAM_STATE_FILE), JSON.stringify(state));
}

/** Increment the candidate session count (read-modify-write; total on corruption). */
export async function bumpDreamSessions(root: string, delta = 1): Promise<void> {
  const state = await readDreamState(root);
  await writeDreamState(root, {
    lastConsolidatedAt: state.lastConsolidatedAt,
    sessionsSince: Math.max(0, state.sessionsSince + delta),
  });
}

/** Record that a dream pass ran: stamp the time and reset the session count. */
export async function markDreamConsolidated(root: string, now: number): Promise<void> {
  await writeDreamState(root, { lastConsolidatedAt: now, sessionsSince: 0 });
}
