/**
 * The shared tool-calling agent loop.
 *
 * Both memory subagents — extraction and dream — are the same loop: seed it with
 * a system prompt + one user message, advertise the memory tools, then drive the
 * model round by round. Each round executes any requested tool calls (which WRITE
 * FILES via core's handlers) and feeds the results back as role:"tool" messages,
 * until the model stops requesting tools or the step cap is reached. The loop
 * never throws for tool errors — handlers return { ok:false } results the
 * subagent can read.
 *
 * Hardening (borrowed from mature agent loops): a hard step cap (≤ 20) so the
 * loop can never run away; exponential-backoff retries on transient completion
 * errors (rate limit / 5xx / network) so a transport blip doesn't fail the whole
 * pass; an abort check before every step for graceful cancellation; and clipping
 * of each tool result fed back, to bound context growth. A completion error that
 * is not transient (or survives retries) propagates, which the caller treats as
 * a failed pass.
 */

import { type MemoryTool, type MemoryToolContext, memoryToolMap } from "@memscribe/core";

import { type ToolCompletion, type ToolMessage, type ToolSpec } from "./tool-completion.js";

const DEFAULT_MAX_STEPS = 12;
/** Hard cap on tool-agent loop rounds. A memory subagent must never run away. */
export const MAX_TOOL_AGENT_STEPS = 20;
/** Retries (beyond the first try) for transient transport/provider errors. */
const RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 500;
/** Clip a single tool result fed back to the model, to bound context growth. */
const MAX_TOOL_RESULT_CHARS = 4000;

export function clampSteps(n: number): number {
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_STEPS;
  return Math.min(Math.trunc(n), MAX_TOOL_AGENT_STEPS);
}

/** Transient transport/provider error worth retrying (rate limit / 5xx / network). */
export function isRetryableError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return /\b(408|409|425|429|5\d\d)\b|rate.?limit|overloaded|too many requests|timeout|timed out|temporarily|unavailable|econnreset|etimedout|enotfound|socket hang up|network|fetch failed/.test(
    msg,
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Call the tool completion with exponential-backoff retries on transient errors. */
async function completeWithRetries(
  toolCompletion: ToolCompletion,
  req: Parameters<ToolCompletion>[0],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<ToolCompletion>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await toolCompletion(req);
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || attempt === RETRY_ATTEMPTS || !isRetryableError(err)) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

function clipToolResult(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
    : text;
}

/** One executed tool call's outcome, surfaced for accounting. */
export interface AgentToolCall {
  name: string;
  ok: boolean;
}

/** Options for {@link runToolAgent}. */
export interface RunToolAgentOptions {
  /** The tool-calling LLM channel. */
  toolCompletion: ToolCompletion;
  /** The memory tools (from core.createMemoryTools()), advertised + executed. */
  tools: MemoryTool[];
  /** The context the handlers write through (shares the held lock). */
  toolCtx: MemoryToolContext;
  /** The system prompt seeding the loop. */
  systemPrompt: string;
  /** The single seed user message rendering the task packet. */
  seedUserMessage: string;
  /** Max model round-trips before the loop stops. Defaults to 12, hard-capped at 20. */
  maxSteps?: number;
  /** Abort signal threaded into each round-trip. */
  signal?: AbortSignal;
}

/** Outcome of a tool-agent run. */
export interface ToolAgentResult {
  /** Number of model round-trips taken. */
  steps: number;
  /** Every executed tool call, in order. */
  toolCalls: AgentToolCall[];
  /** Union of all handlers' changed relative paths. */
  changed: string[];
  /** Why the loop stopped. */
  stoppedReason: "no-tool-calls" | "max-steps" | "aborted";
}

/** Map core memory tools to OpenAI tool specs. */
function toToolSpecs(tools: MemoryTool[]): ToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Run the tool-calling loop. The subagent decides what to persist and calls the
 * memory tools, which write files directly. Pure orchestration: it does not own
 * the lock, cursor, or index — the core session closure does.
 */
export async function runToolAgent(options: RunToolAgentOptions): Promise<ToolAgentResult> {
  // Clamp to the hard cap (≤ MAX_TOOL_AGENT_STEPS): the loop must never run away.
  const maxSteps = clampSteps(
    typeof options.maxSteps === "number" ? options.maxSteps : DEFAULT_MAX_STEPS,
  );

  const toolSpecs = toToolSpecs(options.tools);
  const lookup = memoryToolMap(options.tools);

  const messages: ToolMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.seedUserMessage },
  ];

  const toolCalls: AgentToolCall[] = [];
  const changed: string[] = [];
  let steps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal?.aborted) {
      return { steps, toolCalls, changed, stoppedReason: "aborted" };
    }
    const response = await completeWithRetries(
      options.toolCompletion,
      { messages, tools: toolSpecs, signal: options.signal },
      options.signal,
    );
    steps += 1;
    messages.push(response.message);

    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      return { steps, toolCalls, changed, stoppedReason: "no-tool-calls" };
    }

    for (const call of calls) {
      const tool = lookup.get(call.function.name);
      let result;
      if (!tool) {
        result = { ok: false, text: `unknown tool: ${call.function.name}` };
      } else {
        let args: unknown = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          result = { ok: false, text: "invalid tool arguments: not valid JSON" };
        }
        if (!result) {
          result = await tool.handler(args, options.toolCtx);
        }
      }
      toolCalls.push({ name: call.function.name, ok: result.ok });
      if (result.changed && result.changed.length > 0) changed.push(...result.changed);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clipToolResult(result.text),
      });
    }
  }

  return { steps, toolCalls, changed, stoppedReason: "max-steps" };
}
