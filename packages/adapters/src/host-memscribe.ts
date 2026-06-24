/**
 * Host harness runtime — turn a host-owned canonical model channel into a
 * fully-wired memory scribe the adapters can drive directly.
 *
 * Both memory subagents are tool-calling loops: the SDK ships
 * `createExtractionAgentRunner({ model })` and `createDreamAgentRunner({ model })`,
 * loops that call core's memory-write tools to write files directly. The only
 * model contract here is @memscribe/model's canonical protocol; provider wire
 * shapes and host runtimes are mapped before they enter this file.
 *
 * Nothing here owns provider auth or performs model transport by itself. The
 * host supplies the canonical model object, usually via a HostHarnessPort.
 */

import {
  type DreamAgentRunner,
  type ExtractionAgentRunner,
  type ExtractionMessage,
  type MemScribe as SdkMemScribe,
  type MemScribeLearningLoopConfig,
  type MemoryIndexRetrievalOptions,
  type SessionState,
  type SkillPreludeBuilder,
  type SkillRecallProvider,
  type TurnEndResult,
  createDreamAgentRunner,
  createExtractionAgentRunner,
  createMemScribe,
  runSkillEvolutionAgent,
} from "@memscribe/sdk";
import {
  type LearnedSkillStoreCheckpoint,
  createLearnedSkillRecallProvider,
  createLearnedSkillStore,
} from "@memscribe/skills";
import type { CanonicalModelCompletion } from "@memscribe/model";

import type { MemScribe, MemScribeContext, MemScribeMessage } from "./adapter.js";
import {
  classifyHostCapabilities,
  requireHostCapabilities,
  type HostHarnessPort,
  type HostIntegrationMode,
} from "./harness-port.js";
import type { CanonicalModelMessage } from "@memscribe/model";

/**
 * Re-exported SDK contracts so hosts/adapters depend only on `@memscribe/adapters`.
 */
export type {
  MemScribeLearningLoopConfig,
  MemoryIndexRetrievalOptions,
  SessionState,
  SkillPreludeBuilder,
  SkillRecallProvider,
} from "@memscribe/sdk";
export type { CanonicalModelCompletion } from "@memscribe/model";

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

export type MemScribeHarnessMode = "native" | "recall-only";

/** Options for {@link createMemScribeHarnessRuntime}. */
export interface MemScribeHarnessRuntimeOptions {
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
  mode?: MemScribeHarnessMode;
  /** Memory root override. Falls back to MEMSCRIBE_HOME / OS data dir. */
  root?: string;
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
  learningLoop?: MemScribeLearningLoopConfig;
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
 * Adapter-ready scribe returned by {@link createMemScribeHarnessRuntime}. It
 * satisfies the adapter lifecycle contract.
 */
export interface MemScribeHarnessRuntimeAdapter extends MemScribe {
  onTurnEnd(input: { sessionId: string; messages: MemScribeMessage[] }): Promise<TurnEndResult>;
}

/** The result of {@link createMemScribeHarnessRuntime}. */
export interface MemScribeHarnessRuntime {
  /** The adapter-facing scribe — pass straight to `adapter.attach(scribe, host)`. */
  scribe: MemScribeHarnessRuntimeAdapter;
  /** The underlying SDK scribe, for explicit ops (context/save/runDream). */
  sdk: SdkMemScribe;
  /** Runtime mode after capability/options resolution. */
  mode: HostIntegrationMode | MemScribeHarnessMode;
  /** Detach host lifecycle listeners created from `port`, when any. */
  dispose: () => void;
}

/** A turn message in either the adapter or core shape. */
type AnyTurnMessage = MemScribeMessage | ExtractionMessage;

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

export function canonicalMessagesToMemScribeMessages(
  messages: readonly CanonicalModelMessage[],
): MemScribeMessage[] {
  const outputs = new Map<string, string | null | undefined>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      outputs.set(message.toolCallId, message.content);
    }
  }

  const out: MemScribeMessage[] = [];
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
    out.push(toolCalls.length > 0 ? { role: message.role, text, toolCalls } : { role: message.role, text });
  }
  return out;
}

export function attachMemScribeToHostPort(
  scribe: MemScribeHarnessRuntimeAdapter,
  port: HostHarnessPort,
): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(
    port.lifecycle.onPromptBuild(async (event) => {
      const ctx = await scribe.onPromptBuild({ sessionId: event.sessionId ?? "default", query: event.query });
      return {
        systemPrompt: ctx.systemPrompt,
        preludePrompt: ctx.preludePrompt,
        skillPreludePrompt: ctx.skillPreludePrompt,
      };
    }),
  );
  disposers.push(
    port.lifecycle.onTurnEnd(async (event) => {
      await scribe.onTurnEnd({
        sessionId: event.sessionId,
        messages: canonicalMessagesToMemScribeMessages(event.messages),
      });
    }),
  );
  disposers.push(
    port.lifecycle.onSessionEnd(async (event) => {
      await scribe.onSessionEnd({ sessionId: event.sessionId });
    }),
  );
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

function compactMessages(messages: readonly ExtractionMessage[]): unknown[] {
  return messages.slice(-12).map((message) => ({
    role: message.role,
    text: message.text,
    toolCalls: (message.toolCalls ?? []).map((call) => ({
      name: call.name,
      input: call.input,
      output: call.output,
    })),
  }));
}

function defaultToolTrajectory(input: HostLearnedSkillEvolutionInput): unknown[] {
  return input.session.messages.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => ({
      role: message.role,
      name: call.name,
      input: call.input,
      output: call.output,
    })),
  );
}

function defaultReviewPacket(input: HostLearnedSkillEvolutionInput): unknown {
  return {
    goal: "Review the latest local memory and tool trajectory; create or update one learned skill only when a reusable executable method is present.",
    sessionId: input.sessionId,
    lastExtraction: {
      result: input.lastExtraction.result,
      skipped: input.lastExtraction.skipped,
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
 * Adapt an SDK `MemScribe` (hooks take positional args, onPromptBuild returns a
 * BuildContextResult) to the adapter-facing `MemScribe` (hooks take a single
 * payload object). The two recall segments are structurally identical, so the
 * `MemScribeContext` passes through unchanged. `onAgentEnd` is folded into
 * `onSessionEnd` so the adapter lifecycle's session-end runs a final sweep over
 * any not-yet-extracted messages before dropping the session.
 */
export function adaptSdkMemScribe(sdk: SdkMemScribe): MemScribeHarnessRuntimeAdapter {
  return {
    async onSessionStart(input: { sessionId: string }): Promise<void> {
      await sdk.onSessionStart(input.sessionId);
    },
    async onPromptBuild(input: { sessionId: string; query?: string }): Promise<MemScribeContext> {
      const ctx = await sdk.onPromptBuild({ sessionId: input.sessionId, query: input.query });
      return {
        systemPrompt: ctx.systemPrompt,
        preludePrompt: ctx.preludePrompt,
        skillPreludePrompt: ctx.skillPreludePrompt,
        enabled: ctx.enabled,
      };
    },
    async onTurnEnd(input: { sessionId: string; messages: MemScribeMessage[] }): Promise<TurnEndResult> {
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
export function createMemScribeHarnessRuntime(
  options: MemScribeHarnessRuntimeOptions = {},
): MemScribeHarnessRuntime {
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
      'createMemScribeHarnessRuntime requires a canonical model or explicit extraction agent; pass mode:"recall-only" to disable extraction.',
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
    (requestedMode === "recall-only" || !model ? undefined : createExtractionAgentRunner({ model }));

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

  const sdk = createMemScribe({
    root,
    enabled,
    agent,
    dreamRunner,
    refuseSecrets,
    skillRecall: sdkSkillRecall,
    skillPreludeBuilder,
    learningLoop: sdkLearningLoop,
    memoryIndexRetrieval,
  });
  const scribe = adaptSdkMemScribe(sdk);
  const dispose = options.port ? attachMemScribeToHostPort(scribe, options.port) : () => undefined;
  return {
    scribe,
    sdk,
    mode: options.port ? classifyHostCapabilities(options.port.capabilities) : requestedMode,
    dispose,
  };
}
