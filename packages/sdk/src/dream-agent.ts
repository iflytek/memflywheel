/**
 * The dream-consolidation subagent: the shared tool-calling loop, seeded for
 * dream.
 *
 * Seeds {@link runToolAgent} with the dream system prompt + a user message
 * rendering the structural packets (index / manifest / health / type-review),
 * then drives the model to consolidate by calling the memory tools directly —
 * reading full bodies before merging or compressing. `createDreamAgentRunner`
 * adapts it into core's DreamAgentRunner injection point; core calls it inside
 * the held write lock during a dream pass, after the deterministic pre-pass.
 */

import {
  type MemoryTool,
  type MemoryToolContext,
  type DreamAgentRunner,
  type DreamCoordination,
  type HealthFinding,
  type TypeReviewItem,
  DEFAULT_DREAM_SYSTEM_PROMPT,
  buildDreamAgentUserMessage,
} from "@memscribe/core";

import { type ToolCompletion } from "./tool-completion.js";
import { type ToolAgentResult, runToolAgent } from "./tool-agent.js";

/** Options for {@link runDreamAgent}. */
export interface RunDreamAgentOptions {
  /** The tool-calling LLM channel. */
  toolCompletion: ToolCompletion;
  /** The memory tools (from core.createMemoryTools()), advertised + executed. */
  tools: MemoryTool[];
  /** The context the handlers write through (shares the held lock). */
  toolCtx: MemoryToolContext;
  /** The tool-use system prompt. Defaults to DEFAULT_DREAM_SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** Structural health findings packet. */
  health: HealthFinding[];
  /** Per-file type-review packet (with body excerpts). */
  typeReview: TypeReviewItem[];
  /** Manifest of all memories. */
  manifest: string;
  /** The current MEMORY.md index. */
  index: string;
  /** Optional host directive biasing consolidation (e.g. compress-memory). */
  coordination?: DreamCoordination;
  /** Max model round-trips before the loop stops. Defaults to 12, hard-capped at 20. */
  maxSteps?: number;
  /** Abort signal threaded into each round-trip. */
  signal?: AbortSignal;
}

/** Run the tool-calling dream loop. The subagent consolidates via the memory tools. */
export async function runDreamAgent(options: RunDreamAgentOptions): Promise<ToolAgentResult> {
  return runToolAgent({
    toolCompletion: options.toolCompletion,
    tools: options.tools,
    toolCtx: options.toolCtx,
    systemPrompt: options.systemPrompt ?? DEFAULT_DREAM_SYSTEM_PROMPT,
    seedUserMessage: buildDreamAgentUserMessage({
      health: options.health,
      typeReview: options.typeReview,
      manifest: options.manifest,
      index: options.index,
      coordination: options.coordination,
    }),
    maxSteps: options.maxSteps,
    signal: options.signal,
  });
}

/** Options for {@link createDreamAgentRunner}. */
export interface CreateDreamAgentRunnerOptions {
  /** The tool-calling LLM channel. */
  toolCompletion: ToolCompletion;
  /** Override the tool-use system prompt. */
  systemPrompt?: string;
  /** Max model round-trips per dream pass. Defaults to 12, hard-capped at 20. */
  maxSteps?: number;
}

/**
 * Adapt the dream loop into core's {@link DreamAgentRunner} injection point. Core
 * supplies the bound tools + context (sharing the held lock) and the structural
 * packets; this returns the union of changed paths.
 */
export function createDreamAgentRunner(
  options: CreateDreamAgentRunnerOptions,
): DreamAgentRunner {
  return async function dreamRunner(input) {
    const result = await runDreamAgent({
      toolCompletion: options.toolCompletion,
      tools: input.tools,
      toolCtx: input.toolCtx,
      systemPrompt: options.systemPrompt,
      health: input.health,
      typeReview: input.typeReview,
      manifest: input.manifest,
      index: input.index,
      coordination: input.coordination,
      maxSteps: options.maxSteps,
    });
    return { changed: result.changed };
  };
}
