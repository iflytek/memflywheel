/**
 * The extraction subagent: the shared tool-calling loop, seeded for extraction.
 *
 * Assembles core's memory-write tools into OpenAI tool specs and seeds the loop
 * with the extraction system prompt + a user message rendering the conversation
 * window and existing-memory manifest, then delegates to {@link runToolAgent}.
 * The loop drives the model until it stops requesting tools or the step cap is
 * reached; tool calls WRITE FILES via core's handlers.
 *
 * `createExtractionAgentRunner` adapts the loop into core's ExtractionAgentRunner
 * injection point; core calls it inside the held write lock with tools bound to
 * the same context (so tool writes share that lock).
 */

import {
  type FileTool,
  type FileToolContext,
  type ExtractionAgentRunner,
  type ExtractionMessage,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionAgentUserMessage,
} from "@memscribe/core";

import type { CanonicalModelCompletion } from "@memscribe/model";
import {
  type AgentToolCall,
  type ToolAgentResult,
  MAX_TOOL_AGENT_STEPS,
  runToolAgent,
} from "./tool-agent.js";

export type { AgentToolCall };
/** Hard cap on extraction loop rounds (alias of the shared tool-agent cap). */
export const MAX_EXTRACTION_STEPS = MAX_TOOL_AGENT_STEPS;

/** Options for {@link runExtractionAgent}. */
export interface RunExtractionAgentOptions {
  /** The host-owned canonical model channel. */
  model: CanonicalModelCompletion;
  /** The file tools (from core.createFileTools()), advertised + executed. */
  tools: FileTool[];
  /** The context the handlers write through (shares the held lock). */
  toolCtx: FileToolContext;
  /** The tool-use system prompt. Defaults to DEFAULT_EXTRACTION_SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** The selected conversation window. */
  messages: ExtractionMessage[];
  /** The existing-memory manifest rendered into the seed user message. */
  manifest: string;
  /** Max model round-trips before the loop stops. Defaults to 12, hard-capped at 20. */
  maxSteps?: number;
  /** Abort signal threaded into each round-trip. */
  signal?: AbortSignal;
}

/** Outcome of an extraction agent run (the shared tool-agent result shape). */
export type ExtractionAgentResult = ToolAgentResult;

/** Run the tool-calling extraction loop. The subagent decides what to persist. */
export async function runExtractionAgent(
  options: RunExtractionAgentOptions,
): Promise<ExtractionAgentResult> {
  return runToolAgent({
    model: options.model,
    tools: options.tools,
    toolCtx: options.toolCtx,
    systemPrompt: options.systemPrompt ?? DEFAULT_EXTRACTION_SYSTEM_PROMPT,
    seedUserMessage: buildExtractionAgentUserMessage({
      messages: options.messages,
      manifest: options.manifest,
    }),
    maxSteps: options.maxSteps,
    signal: options.signal,
  });
}

/** Options for {@link createExtractionAgentRunner}. */
export interface CreateExtractionAgentRunnerOptions {
  /** The host-owned canonical model channel. */
  model: CanonicalModelCompletion;
  /** Override the tool-use system prompt. */
  systemPrompt?: string;
  /** Max model round-trips per extraction. Defaults to 12, hard-capped at 20. */
  maxSteps?: number;
}

/**
 * Adapt the agent loop into core's {@link ExtractionAgentRunner} injection point.
 * Core supplies the bound tools + context (sharing the held lock), the message
 * window, manifest, and root; this returns the union of changed paths.
 */
export function createExtractionAgentRunner(
  options: CreateExtractionAgentRunnerOptions,
): ExtractionAgentRunner {
  return async function agentRunner(input) {
    const result = await runExtractionAgent({
      model: options.model,
      tools: input.tools,
      toolCtx: input.toolCtx,
      systemPrompt: options.systemPrompt,
      messages: input.messages,
      manifest: input.manifest,
      maxSteps: options.maxSteps,
    });
    return { changed: result.changed };
  };
}
