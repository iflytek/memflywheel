/**
 * @memscribe/sdk — host lifecycle integration layer.
 *
 * This is the thin orchestration seam between a host runtime (Pi / Claude Code /
 * OpenCode / …) and @memscribe/core. It owns:
 *
 *   - a single per-root StorageContext + audit logger,
 *   - the per-session extraction cursor store,
 *   - the TWO pluggable LLM injection points (agent, dreamRunner),
 *   - the host lifecycle hooks that decide *when* core runs.
 *
 * The scribe itself NEVER calls an LLM. After-turn extraction follows the file-
 * native after-turn flow (lock → relocate → before-scan → cursor window →
 * extraction subagent → relocate → after-scan → syncIndex → advance cursor on
 * success → release → drain queue); the only difference is the LLM-driven write
 * is externalized to the host-provided extraction `agent`. That agent is a
 * tool-calling loop: it calls core's memory tools, which WRITE FILES directly.
 * Dream consolidation is the same kind of subagent over the same channel. The
 * SDK ships batteries-included defaults (createExtractionAgentRunner /
 * createDreamAgentRunner) over a zero-dependency fetch tool-completion, so
 * configuring an API key alone yields real extraction + consolidation.
 *
 * The host gathers the conversation turn into ExtractionMessage[] and calls the
 * hooks; core does the rest (write lock, atomic writes, index sync, cursor).
 */

import {
  type ExtractionAgentRunner,
  type ExtractionMessage,
  type CursorStore,
  type StorageContext,
  type AuditLogger,
  type MemoryDocument,
  type MemoryType,
  type MemoryToolContext,
  type DreamAgentRunner,
  type DreamCoordination,
  type BuildContextResult,
  ExtractionResult,
  getMemoryRoot,
  ensureMemoryDir,
  createAuditLogger,
  createMemoryCursorStore,
  createMemoryTools,
  memoryToolMap,
  runExtractionSession,
  buildContext,
  readMemoryDocument,
  runDreamSession,
  readDreamState,
  bumpDreamSessions,
  shouldRunDream,
  buildMemoryInstructionPrompt,
} from "@memscribe/core";

import {
  type ToolCompletion,
  type ToolCompletionConfig,
  createToolCompletion,
} from "./tool-completion.js";
import { createExtractionAgentRunner } from "./extraction-agent.js";
import { createDreamAgentRunner } from "./dream-agent.js";
import {
  type LearningLoopResult,
  type LearningLoopSource,
  type SkillEvolutionLoopResult,
  type SkillLearningGate,
  runLearningLoop,
} from "./learning-loop.js";

// Re-export the core injection-point contracts so hosts depend only on the SDK.
export type {
  ExtractionAgentRunner,
  ExtractionMessage,
  ExtractionToolCall,
  MemoryTool,
  MemoryToolContext,
  MemoryToolResult,
  MemoryToolName,
  CursorStore,
  DreamAgentRunner,
  DreamSessionResult,
  DreamCoordination,
  MemoryDocument,
  MemoryEntry,
  MemoryType,
  BuildContextResult,
} from "@memscribe/core";
export {
  ExtractionResult,
  createMemoryTools,
  memoryToolMap,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionAgentUserMessage,
} from "@memscribe/core";

// Runtime assembly layer: tool completion + the extraction & dream subagents
// (both the same tool-calling loop, seeded differently).
export {
  type ToolCompletion,
  type ToolCompletionConfig,
  type ToolCompletionRequest,
  type ToolCompletionResponse,
  type ToolMessage,
  type ToolCall,
  type ToolSpec,
  type ToolRole,
  createToolCompletion,
} from "./tool-completion.js";
export {
  type RunToolAgentOptions,
  type ToolAgentResult,
  type AgentToolCall,
  runToolAgent,
  MAX_TOOL_AGENT_STEPS,
} from "./tool-agent.js";
export {
  type RunExtractionAgentOptions,
  type ExtractionAgentResult,
  type CreateExtractionAgentRunnerOptions,
  runExtractionAgent,
  createExtractionAgentRunner,
  MAX_EXTRACTION_STEPS,
} from "./extraction-agent.js";
export {
  type RunDreamAgentOptions,
  type CreateDreamAgentRunnerOptions,
  runDreamAgent,
  createDreamAgentRunner,
} from "./dream-agent.js";
export {
  type SkillEvolutionDecision,
  type SkillEvolutionMemoryAction,
  type SkillEvolutionCoordinationPacket,
  type SkillEvolutionToolResult,
  type SkillEvolutionTool,
  type SkillCheckpoint,
  type LearnedSkillsCatalog,
  type LearnedSkillChangeSet,
  type SkillEvolutionLearningSummary,
  type SkillEvolutionStore,
  type RunSkillEvolutionAgentOptions,
  type SkillEvolutionAgentResult,
  DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT,
  validateSkillEvolutionCoordinationPacket,
  validateSkillEvolutionChangeSet,
  runSkillEvolutionAgent,
} from "./skill-evolution-agent.js";
export {
  type LearningLoopTrigger,
  type LearningLoopSource,
  type SkillLearningGate,
  type SkillLearningGateInput,
  type SkillLearningGateReason,
  type SkillLearningGateResult,
  type DreamCoordinationFromSkill,
  type SkillEvolutionLoopResult,
  type RunLearningLoopOptions,
  type LearningLoopStepResult,
  type LearningLoopResult,
  DEFAULT_SKILL_LEARNING_GATE,
  shouldRunSkillEvolution,
  runLearningLoop,
} from "./learning-loop.js";

export type SkillUsageOutcome = "selected" | "completed" | "failed" | "missed";

export interface SkillUsageRecord {
  sessionId?: string;
  skillName: string;
  outcome: SkillUsageOutcome;
  trigger?: string;
  note?: string;
  errorMessage?: string;
  occurredAt?: string;
}

export interface SkillRecallEntry {
  name: string;
  displayName: string;
  description: string;
  relativePath: string;
  triggerHints?: string[];
}

export interface SkillRecallPacket {
  entries: SkillRecallEntry[];
  usageRecords?: SkillUsageRecord[];
}

export type SkillRecallProvider = (input: {
  sessionId?: string;
  usageRecords: readonly SkillUsageRecord[];
}) => Promise<SkillRecallPacket>;

export type SkillPreludeBuilder = (packet: SkillRecallPacket) => string;

export interface MemScribeLearningLoopConfig {
  enabled?: boolean;
  source?: LearningLoopSource;
  skillLearningEnabled?: boolean;
  gate?: Partial<SkillLearningGate>;
  /**
   * Optional host override for the learning gate. When omitted, the SDK counts
   * tool calls from the session's captured ExtractionMessage.toolCalls.
   */
  toolCalls?: number | (() => number);
  /**
   * Optional host override for the learning cooldown gate. When omitted, the SDK
   * tracks the turn number of the previous skill-evolution pass per session.
   */
  turnsSinceLastSkillEvolution?: number | (() => number);
  skillEvolution?: (input: {
    sessionId: string;
    usageRecords: SkillUsageRecord[];
    lastExtraction: TurnEndResult;
    session: SessionState;
  }) => Promise<SkillEvolutionLoopResult>;
}

export interface MemScribeBuildContextResult extends BuildContextResult {
  skillPreludePrompt?: string;
}

/** Configuration for a memory scribe. The host supplies the LLM injection points. */
export interface MemScribeConfig {
  /** Override the memory root. Falls back to MEMSCRIBE_HOME / OS data dir. */
  root?: string;
  /** Master switch. When false, hooks become no-ops (no scan, no inject, no write). */
  enabled?: boolean;
  /**
   * THE extraction injection point. The host supplies a tool-calling agent loop
   * that calls core's memory tools to write files directly. When absent,
   * after-turn extraction is skipped (recall still works).
   */
  agent?: ExtractionAgentRunner;
  /**
   * THE dream injection point. The host supplies a tool-calling consolidation
   * subagent that reads full bodies and merges / compresses / retires memories
   * by calling core's memory tools directly. When absent, dream runs only the
   * deterministic structural pre-pass.
   */
  dreamRunner?: DreamAgentRunner;
  /**
   * Hard secret gate for the memory write tools. Default OFF — privacy leans on
   * the prompt (matching the default prompt-led privacy model). <private> redaction is
   * always on regardless.
   */
  refuseSecrets?: boolean;
  /** Custom audit logger. Defaults to the file-backed core logger at <root>/.audit.log. */
  audit?: AuditLogger;
  /** Custom cursor store (e.g. persisted). Defaults to an in-memory store. */
  cursorStore?: CursorStore;
  /** Optional learned-skill recall source used during prompt build. */
  skillRecall?: SkillRecallProvider;
  /** Optional renderer for learned-skill recall packets. Defaults to a compact prompt prelude. */
  skillPreludeBuilder?: SkillPreludeBuilder;
  /** Optional turn-end learning loop. When set, onTurnEnd runs extraction -> skill -> dream. */
  learningLoop?: MemScribeLearningLoopConfig;
}

/** What a single session collects between session-start and turn-ends. */
export interface SessionState {
  sessionId: string;
  /** All turn messages seen so far, in order. The extraction cursor indexes into this. */
  messages: ExtractionMessage[];
  /** Number of turns ended in this session (an after-turn extraction per turn). */
  turns: number;
}

/** Result of an after-turn extraction pass surfaced to the host. */
export interface TurnEndResult {
  result: ExtractionResult;
  /** True when the scribe is disabled or no extraction agent is configured. */
  skipped: boolean;
  /** Present when createMemScribe owns the turn-end learning loop. */
  learningLoop?: LearningLoopResult;
}

/** Result of a dream pass surfaced to the host. */
export interface DreamRunResult {
  ran: boolean;
  /** Why dream did/did not run: "disabled" | "gate-not-met" | "locked" | "ok" | "runner-failed". */
  reason: string;
  /** Relative paths changed across the deterministic pre-pass + subagent (when it ran). */
  changed?: string[];
  /** Relative paths deleted by the deterministic pre-pass (when it ran). */
  deleted?: string[];
}

/** Options for an explicit, host-triggered save (memory_save / CLI save). */
export interface SaveOptions {
  type: MemoryType;
  /**
   * Deprecated/ignored: the file path is now derived deterministically from
   * `name` (matching the memory_save tool). Accepted for caller compatibility.
   */
  filename?: string;
  name: string;
  description?: string;
  body: string;
  /** ADD-only override: archive these relativePaths first (explicit user correction). */
  archives?: string[];
}

/** Gate inputs for onIdle (auto-dream). Mirrors core.shouldRunDream. */
export interface DreamGateInput {
  now?: number;
  lastConsolidatedAt?: number | null;
  candidateSessionCount?: number;
  minHours?: number;
  minSessions?: number;
  force?: boolean;
  coordination?: DreamCoordination;
}

function buildSkillInstructionPrompt(): string {
  return `# 技能

系统可能会提供一组可用 learned skill。技能是可执行流程包，不是普通记忆。

## 技能规则

- 可用技能条目只是路由线索，只有当用户请求和技能明确相关时才使用
- 不要把技能步骤复制进普通记忆
- 技能的加载、执行、权限和工具调用由宿主负责，MemScribe 只提供路由和反馈信号
- 如果最近技能使用信号显示失败或未命中，应优先让后续学习闭环修正技能，而不是在回答里编造步骤`;
}

function buildDefaultSkillPrelude(packet: SkillRecallPacket): string {
  const usageRecords = packet.usageRecords ?? [];
  if (packet.entries.length === 0 && usageRecords.length === 0) return "";

  const lines = ["<system-reminder>", "## 可用技能", ""];
  if (packet.entries.length === 0) {
    lines.push("当前没有可用 learned skill。");
  } else {
    for (const entry of packet.entries) {
      lines.push(`- ${entry.name}: ${entry.displayName} — ${entry.description}`);
      lines.push(`  path: ${entry.relativePath}`);
      if (entry.triggerHints && entry.triggerHints.length > 0) {
        lines.push(`  triggers: ${entry.triggerHints.join(", ")}`);
      }
    }
  }

  if (usageRecords.length > 0) {
    lines.push("", "## 最近技能使用信号", "");
    for (const record of usageRecords) {
      const detail = [
        record.trigger ? `trigger=${record.trigger}` : "",
        record.note ? `note=${record.note}` : "",
        record.errorMessage ? `error=${record.errorMessage}` : "",
      ].filter(Boolean);
      lines.push(`- ${record.skillName}: ${record.outcome}${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`);
    }
  }

  lines.push(
    "",
    "仅当当前请求明确命中技能时才请求宿主加载/执行技能；不要向用户暴露技能索引、路径或内部学习过程。",
    "</system-reminder>",
  );
  return lines.join("\n");
}

function resolveCounter(value: number | (() => number)): number {
  return typeof value === "function" ? value() : value;
}

function countToolCalls(messages: readonly ExtractionMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.toolCalls?.length ?? 0;
  }
  return total;
}

/** The host-facing memory scribe. */
export interface MemScribe {
  readonly root: string;
  readonly enabled: boolean;
  readonly ctx: StorageContext;

  // ---- Lifecycle hooks (host calls these at the matching host events) ----

  /** Host session began. Ensures the memory dir exists and registers session state. */
  onSessionStart(sessionId: string): Promise<SessionState>;
  /** A new turn began (host about to build the prompt). Registers session state. */
  onTurnStart(sessionId: string): void;
  /**
   * Host is assembling the prompt. Returns the two recall segments:
   *  - systemPrompt: STABLE memory rules (cache-friendly prefix)
   *  - preludePrompt: DYNAMIC full MEMORY.md index wrapped in <system-reminder>
   */
  onPromptBuild(sessionId?: string): Promise<MemScribeBuildContextResult>;
  /**
   * A turn finished. The host passes the turn's user+assistant messages; the SDK
   * appends them to session state and runs after-turn extraction via the
   * injected agent (the file-native after-turn extraction flow).
   */
  onTurnEnd(sessionId: string, turnMessages: ExtractionMessage[]): Promise<TurnEndResult>;
  /** Host session ended. Drops session state. (Extraction already ran per-turn.) */
  onSessionEnd(sessionId: string): Promise<void>;
  /**
   * The auxiliary/agent run ended (host-level, distinct from a chat turn).
   * Runs a final extraction over any not-yet-processed messages for the session.
   */
  onAgentEnd(sessionId: string): Promise<TurnEndResult>;
  /**
   * Idle / scheduled consolidation. Gate-checked (time OR session-count), then
   * runs runDreamSession under the write lock: the deterministic structural
   * pre-pass, then the consolidation subagent (when a dreamRunner is configured).
   */
  onIdle(opts?: DreamGateInput): Promise<DreamRunResult>;

  // ---- Explicit operations (MCP tools / CLI) ----

  /** memory_context: return the full-index prelude (and stable rules). */
  context(): Promise<MemScribeBuildContextResult>;
  /** memory_read: read one memory document body by relativePath. */
  read(relativePath: string): Promise<MemoryDocument | null>;
  /** memory_save: explicit, validated, ADD-only write (under lock, syncs index). */
  save(options: SaveOptions): Promise<ExtractionResult>;
  /** Force a dream pass regardless of gate (CLI `dream`). */
  runDream(coordination?: DreamCoordination): Promise<DreamRunResult>;

  // ---- Introspection ----

  /** The stable memory-rules system prompt (constant; cache-friendly). */
  instructionPrompt(): string;
  /** Snapshot a session's collected state (or undefined if unknown). */
  getSession(sessionId: string): SessionState | undefined;
  /** Record a host-observed learned-skill selection, completion, miss, or failure. */
  recordSkillUsage(record: SkillUsageRecord): void;
  /** Read recorded skill usage signals, optionally scoped to one session. */
  getSkillUsageRecords(sessionId?: string): SkillUsageRecord[];
}

/** True when an API key for the default tool completion is resolvable from env. */
function hasMemoryLlmKey(): boolean {
  const keys = ["MEMSCRIBE_LLM_API_KEY", "OPENAI_API_KEY"];
  return keys.some((name) => {
    const value = process.env[name];
    return Boolean(value && value.trim());
  });
}

/**
 * Build the default extraction agent from env: wraps {@link createToolCompletion}
 * (OpenAI-compatible tools via MEMSCRIBE_LLM_*) into {@link createExtractionAgentRunner}.
 * The resulting agent is a tool-calling loop that writes memories itself via
 * core's memory tools. Returns undefined when no API key is resolvable, so a
 * recall-only scribe needs no key.
 */
export function defaultExtractionAgentFromEnv(
  config?: ToolCompletionConfig,
): ExtractionAgentRunner | undefined {
  if (!config?.apiKey && !hasMemoryLlmKey()) return undefined;
  const toolCompletion: ToolCompletion = createToolCompletion(config);
  return createExtractionAgentRunner({ toolCompletion });
}

/**
 * Build the default dream consolidation subagent from env, symmetric to
 * {@link defaultExtractionAgentFromEnv}. Both subagents share one tool-calling
 * channel. Returns undefined when no API key is resolvable.
 */
export function defaultDreamRunnerFromEnv(config?: ToolCompletionConfig): DreamAgentRunner | undefined {
  if (!config?.apiKey && !hasMemoryLlmKey()) return undefined;
  const toolCompletion: ToolCompletion = createToolCompletion(config);
  return createDreamAgentRunner({ toolCompletion });
}

/**
 * Build a memory scribe. `root` is resolved once and threaded into a single
 * StorageContext; everything downstream is per-root and lock-coordinated.
 */
export function createMemScribe(config: MemScribeConfig = {}): MemScribe {
  const root = getMemoryRoot({ root: config.root });
  const enabled = config.enabled !== false;
  const audit = config.audit ?? createAuditLogger(root);
  const ctx: StorageContext = { root, audit };
  const cursorStore = config.cursorStore ?? createMemoryCursorStore();
  const agent = config.agent;
  const dreamRunner = config.dreamRunner;
  const refuseSecrets = config.refuseSecrets;
  const skillRecall = config.skillRecall;
  const skillPreludeBuilder = config.skillPreludeBuilder ?? buildDefaultSkillPrelude;
  const learningLoop = config.learningLoop;

  const sessions = new Map<string, SessionState>();
  const skillUsageRecords: SkillUsageRecord[] = [];
  const lastSkillEvolutionTurn = new Map<string, number>();

  function ensureSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { sessionId, messages: [], turns: 0 };
      sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * The shared after-turn extraction path. Appends the turn (when given) then
   * delegates the full lifecycle to core.runExtractionSession with the injected
   * agent (a tool-calling loop that writes files via core's memory tools). No
   * agent / disabled ⇒ a no-op skip.
   */
  async function extract(
    sessionId: string,
    turnMessages?: ExtractionMessage[],
  ): Promise<TurnEndResult> {
    const state = ensureSession(sessionId);
    if (turnMessages && turnMessages.length > 0) {
      state.messages.push(...turnMessages);
      state.turns += 1;
    }
    if (!enabled || !agent) {
      return { result: ExtractionResult.Skipped, skipped: true };
    }
    const result = await runExtractionSession({
      ctx,
      agent,
      messages: state.messages,
      sessionId,
      cursorStore,
      refuseSecrets,
    });
    return { result, skipped: false };
  }

  async function dream(opts: DreamGateInput | undefined, force: boolean): Promise<DreamRunResult> {
    if (!enabled) {
      return { ran: false, reason: "disabled" };
    }
    // Gate inputs default to the scribe's own persisted bookkeeping, so the time /
    // session thresholds work even when the host idle tick threads nothing.
    // An explicitly provided value (including null / 0) overrides the default.
    const persisted = await readDreamState(root);
    const gate = shouldRunDream({
      now: opts?.now,
      lastConsolidatedAt:
        opts?.lastConsolidatedAt !== undefined ? opts.lastConsolidatedAt : persisted.lastConsolidatedAt,
      candidateSessionCount:
        opts?.candidateSessionCount !== undefined ? opts.candidateSessionCount : persisted.sessionsSince,
      minHours: opts?.minHours,
      minSessions: opts?.minSessions,
      force: force || opts?.force,
    });
    if (!gate) {
      return { ran: false, reason: "gate-not-met" };
    }

    const session = await runDreamSession({
      ctx,
      runner: dreamRunner,
      coordination: opts?.coordination,
      refuseSecrets,
    });
    return {
      ran: session.ran,
      reason: session.reason,
      changed: session.changed,
      deleted: session.deleted,
    };
  }

  function getUsageRecords(sessionId?: string): SkillUsageRecord[] {
    return skillUsageRecords
      .filter((record) => sessionId === undefined || record.sessionId === undefined || record.sessionId === sessionId)
      .map((record) => ({ ...record }));
  }

  async function buildPromptContext(sessionId?: string): Promise<MemScribeBuildContextResult> {
    const memoryContext = await buildContext({ root, enabled });
    if (!enabled || !skillRecall) return memoryContext;

    const usageRecords = getUsageRecords(sessionId);
    const packet = await skillRecall({ sessionId, usageRecords });
    const normalizedPacket = {
      ...packet,
      usageRecords: packet.usageRecords ?? usageRecords,
    };
    const skillPreludePrompt = skillPreludeBuilder(normalizedPacket);
    if (!skillPreludePrompt) return { ...memoryContext, skillPreludePrompt: "" };

    return {
      ...memoryContext,
      systemPrompt: [memoryContext.systemPrompt, buildSkillInstructionPrompt()].filter(Boolean).join("\n\n"),
      preludePrompt: [memoryContext.preludePrompt, skillPreludePrompt].filter(Boolean).join("\n\n"),
      skillPreludePrompt,
    };
  }

  async function runTurnEndLearningLoop(
    sessionId: string,
    turnMessages: ExtractionMessage[],
  ): Promise<TurnEndResult> {
    let lastExtraction: TurnEndResult | null = null;
    const stateBeforeTurn = ensureSession(sessionId);
    const doneTurns = stateBeforeTurn.turns + (turnMessages.length > 0 ? 1 : 0);
    const toolCalls =
      learningLoop!.toolCalls !== undefined
        ? resolveCounter(learningLoop!.toolCalls)
        : countToolCalls([...stateBeforeTurn.messages, ...turnMessages]);
    const turnsSinceLastSkillEvolution =
      learningLoop!.turnsSinceLastSkillEvolution !== undefined
        ? resolveCounter(learningLoop!.turnsSinceLastSkillEvolution)
        : doneTurns - (lastSkillEvolutionTurn.get(sessionId) ?? 0);
    const loop = await runLearningLoop({
      trigger: "turn-end",
      source: learningLoop?.source ?? "local",
      enabled: enabled && learningLoop?.enabled !== false,
      skillLearningEnabled: learningLoop?.skillLearningEnabled !== false,
      doneTurns,
      turnsSinceLastSkillEvolution,
      toolCalls,
      gate: learningLoop?.gate,
      extraction: async () => {
        lastExtraction = await extract(sessionId, turnMessages);
        return lastExtraction;
      },
      skillEvolutionPrerequisite: ({ extraction }) => {
        const extractionResult = extraction.value as TurnEndResult | undefined;
        if (extractionResult?.result !== ExtractionResult.Completed) {
          return { ok: false, reason: "extraction-not-completed" };
        }
        return { ok: true, reason: "ok" };
      },
      skillEvolution: learningLoop?.skillEvolution
        ? async () => {
            if (!lastExtraction) throw new Error("skill learning requires extraction to run first");
            return learningLoop.skillEvolution!({
              sessionId,
              usageRecords: getUsageRecords(sessionId),
              lastExtraction,
              session: { ...ensureSession(sessionId), messages: [...ensureSession(sessionId).messages] },
            });
          }
        : undefined,
      dream: async (coordination) =>
        dream({
          coordination: {
            reason: coordination.reason,
            memoryAction: coordination.memoryAction,
            topics: coordination.topics,
            targetSkill: coordination.targetSkill,
          },
          force: true,
        }, true),
    });

    if (loop.skillEvolution.ran) {
      lastSkillEvolutionTurn.set(sessionId, ensureSession(sessionId).turns);
    }

    const extractionResult = loop.extraction.value as TurnEndResult | undefined;
    return {
      ...(extractionResult ?? { result: ExtractionResult.Skipped, skipped: true }),
      learningLoop: loop,
    };
  }

  return {
    root,
    enabled,
    ctx,

    async onSessionStart(sessionId: string): Promise<SessionState> {
      if (enabled) {
        await ensureMemoryDir(root);
      }
      return ensureSession(sessionId);
    },

    onTurnStart(sessionId: string): void {
      ensureSession(sessionId);
    },

    async onPromptBuild(sessionId?: string): Promise<MemScribeBuildContextResult> {
      return buildPromptContext(sessionId);
    },

    async onTurnEnd(
      sessionId: string,
      turnMessages: ExtractionMessage[],
    ): Promise<TurnEndResult> {
      if (learningLoop) {
        return runTurnEndLearningLoop(sessionId, turnMessages);
      }
      return extract(sessionId, turnMessages);
    },

    async onSessionEnd(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
      lastSkillEvolutionTurn.delete(sessionId);
      // Count this ended session toward the dream gate's session threshold.
      if (enabled) {
        try {
          await bumpDreamSessions(root);
        } catch {
          // Bookkeeping is best-effort; never let it break session teardown.
        }
      }
    },

    async onAgentEnd(sessionId: string): Promise<TurnEndResult> {
      // Final sweep over any messages not yet behind the cursor. No new turn.
      return extract(sessionId);
    },

    async onIdle(opts?: DreamGateInput): Promise<DreamRunResult> {
      return dream(opts, false);
    },

    async context(): Promise<MemScribeBuildContextResult> {
      return buildPromptContext();
    },

    async read(relativePath: string): Promise<MemoryDocument | null> {
      return readMemoryDocument(ctx, relativePath);
    },

    async save(options: SaveOptions): Promise<ExtractionResult> {
      if (!enabled) return ExtractionResult.Skipped;
      const { acquireLock, releaseLock } = await import("@memscribe/core");
      const handle = await acquireLock(root, "save");
      if (!handle.acquired) return ExtractionResult.Queued;
      try {
        await ensureMemoryDir(root);
        // Drive the same memory tools the extraction subagent uses, under the
        // held lock. Explicit save is ADD-only: archive corrected paths first.
        const toolCtx: MemoryToolContext = { ctx, refuseSecrets };
        const tools = memoryToolMap(createMemoryTools());
        const archive = tools.get("memory_archive");
        const save = tools.get("memory_save");
        if (!archive || !save) return ExtractionResult.Skipped;

        const changed: string[] = [];
        for (const relativePath of options.archives ?? []) {
          const r = await archive.handler({ relativePath }, toolCtx);
          if (r.ok && r.changed) changed.push(...r.changed);
        }
        const result = await save.handler(
          {
            type: options.type,
            name: options.name,
            description: options.description,
            body: options.body,
          },
          toolCtx,
        );
        if (result.ok && result.changed) changed.push(...result.changed);
        // Handlers already resync the index; nothing more to do.
        return changed.length > 0 ? ExtractionResult.Completed : ExtractionResult.Skipped;
      } finally {
        await releaseLock(root);
      }
    },

    async runDream(coordination?: DreamCoordination): Promise<DreamRunResult> {
      return dream({ coordination, force: true }, true);
    },

    instructionPrompt(): string {
      return buildMemoryInstructionPrompt();
    },

    getSession(sessionId: string): SessionState | undefined {
      return sessions.get(sessionId);
    },

    recordSkillUsage(record: SkillUsageRecord): void {
      if (typeof record.skillName !== "string" || record.skillName.trim() === "") {
        throw new Error("skillName must be a non-empty string");
      }
      if (
        record.outcome !== "selected" &&
        record.outcome !== "completed" &&
        record.outcome !== "failed" &&
        record.outcome !== "missed"
      ) {
        throw new Error("skill usage outcome must be selected, completed, failed, or missed");
      }
      skillUsageRecords.push({
        ...record,
        skillName: record.skillName.trim(),
        occurredAt: record.occurredAt ?? new Date().toISOString(),
      });
    },

    getSkillUsageRecords(sessionId?: string): SkillUsageRecord[] {
      return getUsageRecords(sessionId);
    },
  };
}
