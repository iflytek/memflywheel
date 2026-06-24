/** Shared test doubles (non-test module so it is not run by node --test). */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostRuntime, MemFlywheel, MemFlywheelContext, MemFlywheelMessage } from "./adapter.js";

/** A scribe that records every hook call instead of touching disk. */
export interface RecordingMemFlywheel extends MemFlywheel {
  readonly calls: {
    sessionStart: { sessionId: string }[];
    promptBuild: { sessionId: string; query?: string }[];
    turnEnd: { sessionId: string; messages: MemFlywheelMessage[] }[];
    sessionEnd: { sessionId: string }[];
    idle: ({ force?: boolean } | undefined)[];
  };
}

export function createRecordingMemFlywheel(context?: Partial<MemFlywheelContext>): RecordingMemFlywheel {
  const calls: RecordingMemFlywheel["calls"] = {
    sessionStart: [],
    promptBuild: [],
    turnEnd: [],
    sessionEnd: [],
    idle: [],
  };
  const ctx: MemFlywheelContext = {
    systemPrompt: context?.systemPrompt ?? "RULES",
    preludePrompt: context?.preludePrompt ?? "<system-reminder>INDEX</system-reminder>",
    enabled: context?.enabled ?? true,
  };
  return {
    calls,
    async onSessionStart(input) {
      calls.sessionStart.push(input);
    },
    async onPromptBuild(input) {
      calls.promptBuild.push(input);
      return ctx;
    },
    async onTurnEnd(input) {
      calls.turnEnd.push(input);
    },
    async onSessionEnd(input) {
      calls.sessionEnd.push(input);
    },
    async onIdle(input) {
      calls.idle.push(input);
    },
  };
}

/** An EventEmitter-ish host: `on` returns an unsubscribe function. */
export interface FakeHost extends HostRuntime {
  emit(event: string, payload: unknown): void;
  listenerCount(event: string): number;
}

export function createFakeHost(): FakeHost {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) fn(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

/** A host whose `on` returns void and exposes `off` (the other disposal path). */
export function createOffHost(): FakeHost {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      // returns void — disposal must go through `off`
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) fn(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memflywheel-adapters-"));
}
