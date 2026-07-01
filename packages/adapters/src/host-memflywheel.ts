/**
 * Host harness runtime — turn a host-owned canonical model channel into a
 * fully-wired memory scribe the adapters can drive directly.
 *
 * Both memory subagents are tool-calling loops: the SDK ships
 * `createExtractionAgentRunner({ model })` and `createDreamAgentRunner({ model })`,
 * loops that call core's memory-write tools to write files directly. The only
 * model contract here is @memflywheel/model's canonical protocol; provider wire
 * shapes and host runtimes are mapped before they enter this file.
 *
 * Nothing here owns provider auth or performs model transport by itself. The
 * host supplies the canonical model object, usually via a HostHarnessPort.
 */

import {
  type DreamAgentRunner,
  type ExtractionAgentRunner,
  type ExtractionMessage,
  type CursorStore,
  type MemFlywheel as SdkMemFlywheel,
  type MemFlywheelLearningLoopConfig,
  type MemoryIndexRetrievalOptions,
  type SessionState,
  type SkillPreludeBuilder,
  type SkillRecallProvider,
  type TurnEndResult,
  createDreamAgentRunner,
  createExtractionAgentRunner,
  createMemFlywheel,
  runSkillEvolutionAgent,
} from "@memflywheel/sdk";
import {
  type LearnedSkillStoreCheckpoint,
  createLearnedSkillRecallProvider,
  createLearnedSkillStore,
} from "@memflywheel/skills";
import type {
  CanonicalModelCompletion,
  CanonicalModelMessage,
  CanonicalToolCall,
} from "@memflywheel/model";

import type { MemFlywheel, MemFlywheelContext, MemFlywheelMessage } from "./adapter.js";
import {
  classifyHostCapabilities,
  requireHostCapabilities,
  type HostToolCallEvent,
  type HostToolResultEvent,
  type HostHarnessPort,
  type HostIntegrationMode,
} from "./harness-port.js";

/**
 * Re-exported SDK contracts so hosts/adapters depend only on `@iflytekopensource/adapters`.
 */
export type {
  MemFlywheelLearningLoopConfig,
  MemoryIndexRetrievalOptions,
  SessionState,
  SkillPreludeBuilder,
  SkillRecallProvider,
} from "@memflywheel/sdk";
export type { CanonicalModelCompletion } from "@memflywheel/model";

export interface HostLearnedSkillEvolutionInput {
  sessionId: string;
  lastExtraction: TurnEndResult;
  session: SessionState;
}

export interface HostLearnedSkillsOptions {
  /** Directory where learned skills are finalized as file-native packages. */
  skillsRoot: string;
  /** Directory for staged skill checkpoints. Defaults to <skillsRoot>/.checkpoints. */
  checkpointRoot?: string;
  /** Public-name residues rejected from generated skill text. */
  forbiddenPublicNames?: readonly string[];
  /** Include current skill content in the skill-evolution prompt. */
  includeSkillContent?: boolean;
  /** Override the skill-evolution system prompt. */
  systemPrompt?: string;
  /** Max tool-calling rounds for the skill-evolution subagent. */
  maxSteps?: number;
  /** Build the review packet sent to the skill-evolution subagent. */
  reviewPacket?: (input: HostLearnedSkillEvolutionInput) => unknown;
  /** Build the tool trajectory sent to the skill-evolution subagent. */
  toolTrajectory?: (input: HostLearnedSkillEvolutionInput) => unknown;
  /** Build artifact path hints sent to the skill-evolution subagent. */
  artifactPaths?: (input: HostLearnedSkillEvolutionInput) => string[];
  /** Build quality signals sent to the skill-evolution subagent. */
  qualitySignals?: (input: HostLearnedSkillEvolutionInput) => unknown;
}

export type MemFlywheelHarnessMode = "native" | "recall-only";

/** Options for {@link createMemFlywheelHarnessRuntime}. */
export interface MemFlywheelHarnessRuntimeOptions {
  /**
   * Optional host port. Phase 1 uses the port's canonical model; lifecycle
   * binding remains explicit so existing adapter attach tests stay focused.
   */
  port?: HostHarnessPort;
  /**
   * Host-owned canonical model channel. Drives BOTH subagents — extraction and
   * dream consolidation — which write memories directly via core's tools.
   */
  model?: CanonicalModelCompletion;
  /** Explicit runtime mode. No implicit recall-only fallback. */
  mode?: MemFlywheelHarnessMode;
  /** Memory root override. Falls back to MEMFLYWHEEL_HOME / OS data dir. */
  root?: string;
  /** Custom cursor store. Defaults to the SDK in-memory cursor store. */
  cursorStore?: CursorStore;
  /** Master switch. When false, every hook becomes a no-op. */
  enabled?: boolean;
  /**
   * Hard secret gate for the memory write tools. Default OFF — privacy leans on
   * the extraction prompt. `<private>` redaction is always on regardless.
   */
  refuseSecrets?: boolean;
  /**
   * Provide an extraction agent explicitly instead of building one from `model`.
   * Takes precedence over `model` for extraction.
   */
  agent?: ExtractionAgentRunner;
  /**
   * Provide a dream consolidation subagent explicitly. Defaults to one built from
   * `model`; pass `null` to disable semantic consolidation
   * (deterministic structural pre-pass only).
   */
  dreamRunner?: DreamAgentRunner | null;
  /** Optional learned-skill recall source used during prompt build. */
  skillRecall?: SkillRecallProvider;
  /** Optional renderer for learned-skill recall packets. Defaults to the SDK renderer. */
  skillPreludeBuilder?: SkillPreludeBuilder;
  /** Optional turn-end learning loop. When set, onTurnEnd runs extraction -> skill -> dream. */
  learningLoop?: MemFlywheelLearningLoopConfig;
  /** Optional MEMORY.md index-layer hybrid retrieval. Host owns embedding/auth. */
  memoryIndexRetrieval?: MemoryIndexRetrievalOptions;
  /**
   * Opt-in learned-skill assembly. When set with `model`, the bridge creates a
   * file-native learned-skill store, recall provider, and
   * skill-evolution runner. Hosts may still override `learningLoop` gates or
   * packet builders, but no custom callback is required for the closed path.
   */
  learnedSkills?: HostLearnedSkillsOptions;
}

/**
 * Adapter-ready scribe returned by {@link createMemFlywheelHarnessRuntime}. It
 * satisfies the adapter lifecycle contract.
 */
export interface MemFlywheelHarnessRuntimeAdapter extends MemFlywheel {
  onTurnEnd(input: { sessionId: string; messages: MemFlywheelMessage[] }): Promise<TurnEndResult>;
}

/** The result of {@link createMemFlywheelHarnessRuntime}. */
export interface MemFlywheelHarnessRuntime {
  /** The adapter-facing scribe — pass straight to `adapter.attach(scribe, host)`. */
  scribe: MemFlywheelHarnessRuntimeAdapter;
  /** The underlying SDK scribe, for explicit ops (context/save/runDream). */
  sdk: SdkMemFlywheel;
  /** Runtime mode after capability/options resolution. */
  mode: HostIntegrationMode | MemFlywheelHarnessMode;
  /** Detach host lifecycle listeners created from `port`, when any. */
  dispose: () => void;
}

/** A turn message in either the adapter or core shape. */
type AnyTurnMessage = MemFlywheelMessage | ExtractionMessage;

function toExtractionMessages(messages: AnyTurnMessage[]): ExtractionMessage[] {
  const out: ExtractionMessage[] = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = typeof m.text === "string" ? m.text.trim() : "";
    const toolCalls = (m as ExtractionMessage).toolCalls;
    const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
    // Keep a tool-only assistant turn (empty text but real tool calls).
    if (text === "" && !hasTools) continue;
    const out1: ExtractionMessage = { role: m.role, text };
    if (hasTools) out1.toolCalls = toolCalls;
    const timestamp = (m as ExtractionMessage).timestamp;
    if (typeof timestamp === "string" && timestamp.trim() !== "") out1.timestamp = timestamp.trim();
    out.push(out1);
  }
  return out;
}

export function canonicalMessagesToMemFlywheelMessages(
  messages: readonly CanonicalModelMessage[],
): MemFlywheelMessage[] {
  const outputs = new Map<string, string | null | undefined>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      outputs.set(message.toolCallId, message.content);
    }
  }

  const out: MemFlywheelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content.trim() : "";
    const toolCalls =
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => ({
            name: call.name,
            input: call.input,
            output: outputs.get(call.id),
          }))
        : [];
    if (text === "" && toolCalls.length === 0) continue;
    out.push(
      toolCalls.length > 0 ? { role: message.role, text, toolCalls } : { role: message.role, text },
    );
  }
  return out;
}

interface BufferedToolCall extends CanonicalToolCall {
  output?: unknown;
}

function sessionKey(sessionId: string | undefined): string {
  return sessionId?.trim() || "default";
}

function contentFromToolOutput(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function existingToolCallIds(messages: readonly CanonicalModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) ids.add(call.id);
  }
  return ids;
}

function recordToolCall(
  toolCallsBySession: Map<string, Map<string, BufferedToolCall>>,
  event: HostToolCallEvent,
): void {
  if (!event.toolCallId) return;
  const key = sessionKey(event.sessionId);
  let session = toolCallsBySession.get(key);
  if (!session) {
    session = new Map();
    toolCallsBySession.set(key, session);
  }
  const existing = session.get(event.toolCallId);
  session.set(event.toolCallId, {
    id: event.toolCallId,
    name: event.toolName,
    input: event.input,
    output: existing?.output,
  });
}

function recordToolResult(
  toolCallsBySession: Map<string, Map<string, BufferedToolCall>>,
  event: HostToolResultEvent,
): void {
  if (!event.toolCallId) return;
  const key = sessionKey(event.sessionId);
  let session = toolCallsBySession.get(key);
  if (!session) {
    session = new Map();
    toolCallsBySession.set(key, session);
  }
  const existing = session.get(event.toolCallId);
  session.set(event.toolCallId, {
    id: event.toolCallId,
    name: existing?.name ?? event.toolName,
    input: existing?.input ?? event.input,
    output: event.output,
  });
}

function drainTelemetryMessages(
  toolCallsBySession: Map<string, Map<string, BufferedToolCall>>,
  sessionId: string,
  baseMessages: readonly CanonicalModelMessage[],
): CanonicalModelMessage[] {
  const calls = toolCallsBySession.get(sessionKey(sessionId));
  if (!calls || calls.size === 0) return [];
  toolCallsBySession.delete(sessionKey(sessionId));

  const seen = existingToolCallIds(baseMessages);
  const unique = [...calls.values()].filter((call) => !seen.has(call.id));
  if (unique.length === 0) return [];

  const messages: CanonicalModelMessage[] = [
    {
      role: "assistant",
      content: null,
      toolCalls: unique.map(({ id, name, input }) => ({ id, name, input })),
    },
  ];
  for (const call of unique) {
    const content = contentFromToolOutput(call.output);
    if (content !== null) messages.push({ role: "tool", toolCallId: call.id, content });
  }
  return messages;
}

export function attachMemFlywheelToHostPort(
  scribe: MemFlywheelHarnessRuntimeAdapter,
  port: HostHarnessPort,
): () => void {
  const disposers: Array<() => void> = [];
  const toolCallsBySession = new Map<string, Map<string, BufferedToolCall>>();
  disposers.push(
    port.lifecycle.onPromptBuild(async (event) => {
      const ctx = await scribe.onPromptBuild({
        sessionId: event.sessionId ?? "default",
        query: event.query,
      });
      return {
        systemPrompt: ctx.systemPrompt,
        preludePrompt: ctx.preludePrompt,
        skillPreludePrompt: ctx.skillPreludePrompt,
      };
    }),
  );
  disposers.push(
    port.lifecycle.onTurnEnd(async (event) => {
      const telemetryMessages = drainTelemetryMessages(
        toolCallsBySession,
        event.sessionId,
        event.messages,
      );
      await scribe.onTurnEnd({
        sessionId: event.sessionId,
        messages: canonicalMessagesToMemFlywheelMessages([...event.messages, ...telemetryMessages]),
      });
    }),
  );
  disposers.push(
    port.lifecycle.onSessionEnd(async (event) => {
      toolCallsBySession.delete(sessionKey(event.sessionId));
      await scribe.onSessionEnd({ sessionId: event.sessionId });
    }),
  );
  if (port.telemetry?.onToolCall) {
    disposers.push(
      port.telemetry.onToolCall(async (event) => recordToolCall(toolCallsBySession, event)),
    );
  }
  if (port.telemetry?.onToolResult) {
    disposers.push(
      port.telemetry.onToolResult(async (event) => recordToolResult(toolCallsBySession, event)),
    );
  }
  if (port.lifecycle.onIdle) {
    disposers.push(
      port.lifecycle.onIdle(async (event) => {
        await scribe.onIdle(event);
      }),
    );
  }
  return () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };
}

const SKILL_CONTEXT_MESSAGE_LIMIT = 20;
const SKILL_CONTEXT_TEXT_LIMIT = 2_000;
const SKILL_CONTEXT_INPUT_LIMIT = 1_000;
const SKILL_CONTEXT_OUTPUT_HEAD = 800;
const SKILL_CONTEXT_OUTPUT_TAIL = 400;

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n...[truncated ${value.length - limit} chars]`;
  return `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function truncateValue(value: unknown, limit: number): unknown {
  if (typeof value === "string") return truncateString(value, limit);
  const rendered = JSON.stringify(value);
  if (!rendered || rendered.length <= limit) return value;
  return truncateString(rendered, limit);
}

function previewOutput(output: unknown): unknown {
  const rendered = typeof output === "string" ? output : JSON.stringify(output);
  if (!rendered || rendered.length <= SKILL_CONTEXT_OUTPUT_HEAD + SKILL_CONTEXT_OUTPUT_TAIL) {
    return output;
  }
  return {
    truncated: true,
    chars: rendered.length,
    head: rendered.slice(0, SKILL_CONTEXT_OUTPUT_HEAD),
    tail: rendered.slice(-SKILL_CONTEXT_OUTPUT_TAIL),
  };
}

function compactMessages(messages: readonly ExtractionMessage[]): unknown[] {
  return messages.slice(-SKILL_CONTEXT_MESSAGE_LIMIT).map((message) => ({
    role: message.role,
    text: truncateString(message.text, SKILL_CONTEXT_TEXT_LIMIT),
    toolCalls: (message.toolCalls ?? []).map((call) => ({
      name: call.name,
      input: truncateValue(call.input, SKILL_CONTEXT_INPUT_LIMIT),
    })),
  }));
}

function defaultToolTrajectory(input: HostLearnedSkillEvolutionInput): unknown[] {
  return input.session.messages.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => ({
      role: message.role,
      name: call.name,
      input: truncateValue(call.input, SKILL_CONTEXT_INPUT_LIMIT),
      output: previewOutput(call.output),
    })),
  );
}

function defaultReviewPacket(input: HostLearnedSkillEvolutionInput): unknown {
  return {
    goal: "Review the latest local memory and tool trajectory; create or update one learned skill only when a reusable executable method is present.",
    sessionId: input.sessionId,
    lastExtraction: {
      result: input.lastExtraction.result,
    },
    recentMessages: compactMessages(input.session.messages),
  };
}

function defaultQualitySignals(input: HostLearnedSkillEvolutionInput): unknown {
  const toolTrajectory = defaultToolTrajectory(input);
  return {
    source: "local",
    doneTurns: input.session.turns,
    toolCalls: toolTrajectory.length,
  };
}

/**
 * Adapt an SDK `MemFlywheel` (hooks take positional args, onPromptBuild returns a
 * BuildContextResult) to the adapter-facing `MemFlywheel` (hooks take a single
 * payload object). The two recall segments are structurally identical, so the
 * `MemFlywheelContext` passes through unchanged. `onAgentEnd` is folded into
 * `onSessionEnd` so the adapter lifecycle's session-end runs a final sweep over
 * any not-yet-extracted messages before dropping the session.
 */
export function adaptSdkMemFlywheel(sdk: SdkMemFlywheel): MemFlywheelHarnessRuntimeAdapter {
  return {
    async onSessionStart(input: { sessionId: string }): Promise<void> {
      await sdk.onSessionStart(input.sessionId);
    },
    async onPromptBuild(input: { sessionId: string; query?: string }): Promise<MemFlywheelContext> {
      const ctx = await sdk.onPromptBuild({ sessionId: input.sessionId, query: input.query });
      return {
        systemPrompt: ctx.systemPrompt,
        preludePrompt: ctx.preludePrompt,
        skillPreludePrompt: ctx.skillPreludePrompt,
        enabled: ctx.enabled,
      };
    },
    async onTurnEnd(input: {
      sessionId: string;
      messages: MemFlywheelMessage[];
    }): Promise<TurnEndResult> {
      return sdk.onTurnEnd(input.sessionId, toExtractionMessages(input.messages));
    },
    async onSessionEnd(input: { sessionId: string }): Promise<void> {
      // Final sweep over any messages not yet behind the cursor, then drop state.
      await sdk.onAgentEnd(input.sessionId);
      await sdk.onSessionEnd(input.sessionId);
    },
    async onIdle(input?: { force?: boolean }): Promise<void> {
      await sdk.onIdle({ force: input?.force });
    },
  };
}

/**
 * Build a batteries-included scribe from a host's canonical model channel.
 *
 * - With `model`: real semantic extraction + consolidation run as
 *   tool-calling subagents on the host's own model, writing memory files directly.
 * - Without `model` and without an explicit `agent`: pass `mode:"recall-only"`
 *   explicitly, or construction fails.
 */
export function createMemFlywheelHarnessRuntime(
  options: MemFlywheelHarnessRuntimeOptions = {},
): MemFlywheelHarnessRuntime {
  const {
    root,
    enabled,
    refuseSecrets,
    skillRecall,
    skillPreludeBuilder,
    learningLoop,
    memoryIndexRetrieval,
    learnedSkills,
  } = options;
  const model = options.model ?? options.port?.model;
  const requestedMode = options.mode ?? "native";

  if (requestedMode !== "recall-only" && !model && !options.agent) {
    throw new Error(
      'createMemFlywheelHarnessRuntime requires a canonical model or explicit extraction agent; pass mode:"recall-only" to disable extraction.',
    );
  }
  if (options.port && requestedMode !== "recall-only") {
    requireHostCapabilities(options.port.name, options.port.capabilities, [
      "prompt-build",
      "turn-end",
      "agentic-tool-loop",
    ]);
  }

  const agent =
    options.agent ??
    (requestedMode === "recall-only" || !model
      ? undefined
      : createExtractionAgentRunner({ model }));

  let dreamRunner: DreamAgentRunner | undefined;
  if (options.dreamRunner === null) {
    dreamRunner = undefined;
  } else if (options.dreamRunner) {
    dreamRunner = options.dreamRunner;
  } else if (requestedMode !== "recall-only" && model) {
    dreamRunner = createDreamAgentRunner({ model });
  }

  let sdkSkillRecall = skillRecall;
  let sdkLearningLoop = learningLoop;
  if (learnedSkills) {
    if (!model) {
      throw new Error("learnedSkills requires a canonical model");
    }
    if (options.port) {
      requireHostCapabilities(options.port.name, options.port.capabilities, [
        "prompt-build",
        "turn-end",
        "agentic-tool-loop",
        "tool-trajectory",
      ]);
    }
    const store = createLearnedSkillStore({
      skillsRoot: learnedSkills.skillsRoot,
      checkpointRoot: learnedSkills.checkpointRoot,
      forbiddenPublicNames: learnedSkills.forbiddenPublicNames,
    });
    sdkSkillRecall ??= createLearnedSkillRecallProvider({
      skillsRoot: learnedSkills.skillsRoot,
      forbiddenPublicNames: learnedSkills.forbiddenPublicNames,
    });
    const assembledSkillEvolution = async (input: HostLearnedSkillEvolutionInput) =>
      runSkillEvolutionAgent<LearnedSkillStoreCheckpoint>({
        model,
        store,
        sessionId: input.sessionId,
        reviewPacket: (learnedSkills.reviewPacket ?? defaultReviewPacket)(input),
        toolTrajectory: (learnedSkills.toolTrajectory ?? defaultToolTrajectory)(input),
        artifactPaths: learnedSkills.artifactPaths ? learnedSkills.artifactPaths(input) : [],
        qualitySignals: (learnedSkills.qualitySignals ?? defaultQualitySignals)(input),
        includeSkillContent: learnedSkills.includeSkillContent,
        systemPrompt: learnedSkills.systemPrompt,
        maxSteps: learnedSkills.maxSteps,
      });

    sdkLearningLoop = {
      enabled: true,
      source: "local",
      skillLearningEnabled: true,
      ...learningLoop,
      skillEvolution: learningLoop?.skillEvolution ?? assembledSkillEvolution,
    };
  }

  const sdk = createMemFlywheel({
    root,
    enabled,
    agent,
    dreamRunner,
    cursorStore: options.cursorStore,
    refuseSecrets,
    skillRecall: sdkSkillRecall,
    skillPreludeBuilder,
    learningLoop: sdkLearningLoop,
    memoryIndexRetrieval,
  });
  const scribe = adaptSdkMemFlywheel(sdk);
  const dispose = options.port
    ? attachMemFlywheelToHostPort(scribe, options.port)
    : () => undefined;
  return {
    scribe,
    sdk,
    mode: options.port ? classifyHostCapabilities(options.port.capabilities) : requestedMode,
    dispose,
  };
}
