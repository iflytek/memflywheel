/**
 * @memflywheel/sdk — host lifecycle integration layer.
 *
 * This is the thin orchestration seam between a host runtime (Pi / Claude Code /
 * OpenCode / …) and @memflywheel/core. It owns:
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
 * tool-calling loop: it calls ordinary file tools, which WRITE FILES directly.
 * Dream consolidation is the same kind of subagent over the same channel. The
 * SDK ships the extraction / dream / skill loops over a provider-neutral
 * canonical model contract. Providers and host runtimes live outside the SDK.
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
  type MemoryType,
  type DreamAgentRunner,
  type DreamCoordination,
  type BuildContextResult,
  type MemoryIndexRetrievalOptions,
  ExtractionResult,
  getMemoryRoot,
  ensureMemoryDir,
  createAuditLogger,
  createMemoryCursorStore,
  createFileTools,
  fileToolMap,
  createMemoryFileToolContext,
  serializeMemoryFile,
  runExtractionSession,
  buildContext,
  runDreamSession,
  readDreamState,
  bumpDreamSessions,
  shouldRunDream,
  buildMemoryInstructionPrompt,
  archiveMemoryDocument,
  syncMemoryIndex,
  deriveMemoryFilename,
} from "@memflywheel/core";

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
  FileTool,
  FileToolContext,
  FileToolResult,
  FileToolName,
  CursorStore,
  DreamAgentRunner,
  DreamSessionResult,
  DreamCoordination,
  MemoryDocument,
  MemoryEntry,
  MemoryType,
  BuildContextResult,
  EmbeddingProvider,
  MemoryIndexRetrievalOptions,
} from "@memflywheel/core";
export {
  ExtractionResult,
  createFileTools,
  fileToolMap,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionAgentUserMessage,
} from "@memflywheel/core";

// Provider-neutral model protocol plus provider mappers.
export {
  type JsonSchemaObject,
  type CanonicalModelRole,
  type CanonicalToolCall,
  type CanonicalModelMessage,
  type CanonicalToolDefinition,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type CanonicalModelCompletion,
  type CanonicalModelComplete,
  type CanonicalEmbeddingProvider,
  type OpenAIChatCompletionsModelConfig,
  type OpenAIEmbeddingsModelConfig,
  createOpenAIChatCompletionsModel,
  createOpenAIEmbeddingsModel,
} from "@memflywheel/model";

// Runtime assembly layer: the extraction & dream subagents over the canonical
// model protocol (both the same tool-calling loop, seeded differently).
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
  type SkillEvolutionCoordination,
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
  validateSkillEvolutionCoordination,
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

export interface SkillRecallEntry {
  name: string;
  displayName: string;
  description: string;
  relativePath: string;
  triggerHints?: string[];
}

export interface SkillRecallPacket {
  entries: SkillRecallEntry[];
}

export type SkillRecallProvider = (input: { sessionId?: string }) => Promise<SkillRecallPacket>;

export type SkillPreludeBuilder = (packet: SkillRecallPacket) => string;

export interface MemFlywheelLearningLoopConfig {
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
    lastExtraction: TurnEndResult;
    session: SessionState;
  }) => Promise<SkillEvolutionLoopResult>;
}

export interface MemFlywheelBuildContextResult extends BuildContextResult {
  skillPreludePrompt?: string;
}

export interface PromptBuildInput {
  sessionId?: string;
  query?: string;
}

/** Configuration for a memory scribe. The host supplies the LLM injection points. */
export interface MemFlywheelConfig {
  /** Override the memory root. Falls back to MEMFLYWHEEL_HOME / OS data dir. */
  root?: string;
  /** Master switch. When false, hooks become no-ops (no scan, no inject, no write). */
  enabled?: boolean;
  /**
   * THE extraction injection point. The host supplies a tool-calling agent loop
   * that calls ordinary file tools to write files directly. When absent,
   * after-turn extraction is skipped (recall still works).
   */
  agent?: ExtractionAgentRunner;
  /**
   * THE dream injection point. The host supplies a tool-calling consolidation
   * subagent that reads full bodies and merges / compresses / retires memories
   * by calling ordinary file tools directly. When absent, dream runs only the
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
  learningLoop?: MemFlywheelLearningLoopConfig;
  /** Optional MEMORY.md index-layer hybrid retrieval. Host still owns the embedding provider. */
  memoryIndexRetrieval?: MemoryIndexRetrievalOptions;
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
  /** Present when createMemFlywheel owns the turn-end learning loop. */
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

/** Options for an explicit, host-triggered memory write. */
export interface SaveOptions {
  type: MemoryType;
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
- 技能的加载、执行、权限和工具调用由宿主负责，MemFlywheel 只提供路由线索
- 技能学习基于对话记录和工具调用轨迹，不要在回答里编造未执行的步骤`;
}

function buildDefaultSkillPrelude(packet: SkillRecallPacket): string {
  if (packet.entries.length === 0) return "";

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
export interface MemFlywheel {
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
   *  - preludePrompt: DYNAMIC index cues wrapped in <system-reminder>
   */
  onPromptBuild(input?: PromptBuildInput): Promise<MemFlywheelBuildContextResult>;
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

  // ---- Explicit host operations ----

  /** Return the default index prelude and stable memory rules. */
  context(): Promise<MemFlywheelBuildContextResult>;
  /** Explicit, validated memory write (under lock, syncs index). */
  save(options: SaveOptions): Promise<ExtractionResult>;
  /** Force a dream pass regardless of gate. */
  runDream(coordination?: DreamCoordination): Promise<DreamRunResult>;

  // ---- Introspection ----

  /** The stable memory-rules system prompt (constant; cache-friendly). */
  instructionPrompt(): string;
  /** Snapshot a session's collected state (or undefined if unknown). */
  getSession(sessionId: string): SessionState | undefined;
}

/**
 * Build a memory scribe. `root` is resolved once and threaded into a single
 * StorageContext; everything downstream is per-root and lock-coordinated.
 */
export function createMemFlywheel(config: MemFlywheelConfig = {}): MemFlywheel {
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
  const memoryIndexRetrieval = config.memoryIndexRetrieval;

  const sessions = new Map<string, SessionState>();
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
   * agent (a tool-calling loop that writes files via ordinary file tools). No
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
        opts?.lastConsolidatedAt !== undefined
          ? opts.lastConsolidatedAt
          : persisted.lastConsolidatedAt,
      candidateSessionCount:
        opts?.candidateSessionCount !== undefined
          ? opts.candidateSessionCount
          : persisted.sessionsSince,
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

  async function buildPromptContext(
    input?: PromptBuildInput,
  ): Promise<MemFlywheelBuildContextResult> {
    const memoryContext = await buildContext({
      root,
      enabled,
      query: input?.query,
      indexRetrieval: memoryIndexRetrieval,
    });
    if (!enabled || !skillRecall) return memoryContext;

    const packet = await skillRecall({ sessionId: input?.sessionId });
    const skillPreludePrompt = skillPreludeBuilder(packet);
    if (!skillPreludePrompt) return { ...memoryContext, skillPreludePrompt: "" };

    return {
      ...memoryContext,
      systemPrompt: [memoryContext.systemPrompt, buildSkillInstructionPrompt()]
        .filter(Boolean)
        .join("\n\n"),
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
    const loopToolCalls = learningLoop?.toolCalls;
    const toolCalls =
      loopToolCalls !== undefined
        ? resolveCounter(loopToolCalls)
        : countToolCalls([...stateBeforeTurn.messages, ...turnMessages]);
    const loopTurnsSince = learningLoop?.turnsSinceLastSkillEvolution;
    const turnsSinceLastSkillEvolution =
      loopTurnsSince !== undefined
        ? resolveCounter(loopTurnsSince)
        : doneTurns - (lastSkillEvolutionTurn.get(sessionId) ?? 0);
    const skillEvolve = learningLoop?.skillEvolution;
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
      skillEvolution: skillEvolve
        ? async () => {
            if (!lastExtraction) throw new Error("skill learning requires extraction to run first");
            return skillEvolve({
              sessionId,
              lastExtraction,
              session: {
                ...ensureSession(sessionId),
                messages: [...ensureSession(sessionId).messages],
              },
            });
          }
        : undefined,
      dream: async (coordination) =>
        dream(
          {
            coordination: {
              reason: coordination.reason,
              memoryAction: coordination.memoryAction,
              topics: coordination.topics,
              targetSkill: coordination.targetSkill,
            },
            force: true,
          },
          true,
        ),
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

    async onPromptBuild(input?: PromptBuildInput): Promise<MemFlywheelBuildContextResult> {
      return buildPromptContext(input);
    },

    async onTurnEnd(sessionId: string, turnMessages: ExtractionMessage[]): Promise<TurnEndResult> {
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

    async context(): Promise<MemFlywheelBuildContextResult> {
      return buildPromptContext();
    },

    async save(options: SaveOptions): Promise<ExtractionResult> {
      if (!enabled) return ExtractionResult.Skipped;
      const { acquireLock, releaseLock } = await import("@memflywheel/core");
      const handle = await acquireLock(root, "save");
      if (!handle.acquired) return ExtractionResult.Queued;
      try {
        await ensureMemoryDir(root);
        const toolCtx = createMemoryFileToolContext({ ctx, refuseSecrets });
        const tools = fileToolMap(createFileTools());
        const write = tools.get("write");
        if (!write) return ExtractionResult.Skipped;

        const changed: string[] = [];
        for (const relativePath of options.archives ?? []) {
          const archived = await archiveMemoryDocument(ctx, relativePath);
          if (archived) changed.push(archived);
        }
        const result = await write.handler(
          {
            filePath: `${options.type}/${deriveMemoryFilename(options.name)}`,
            content: serializeMemoryFile({
              type: options.type,
              name: options.name,
              description: options.description,
              body: options.body,
            }),
          },
          toolCtx,
        );
        if (result.ok && result.changed) changed.push(...result.changed);
        await syncMemoryIndex(root);
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
  };
}
