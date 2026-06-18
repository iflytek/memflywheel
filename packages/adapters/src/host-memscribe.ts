/**
 * Host-scribe bridge — turn a host's own LLM channel into a fully-wired,
 * batteries-included memory scribe the adapters can drive directly.
 *
 * Both memory subagents are tool-calling loops: the SDK ships
 * `createExtractionAgentRunner({ toolCompletion })` and
 * `createDreamAgentRunner({ toolCompletion })`, loops that call core's
 * memory-write tools to write files directly. The only thing a host must supply
 * is `toolCompletion`: the thinnest possible OpenAI-compatible tool-calling
 * channel over its own model. This module wraps it into both subagents, builds a
 * real `createMemScribe`, and exposes it through the adapter-facing `MemScribe`
 * structural contract (see adapter.ts) so any built-in adapter can `attach` it
 * to a live host with no extra glue.
 *
 * Nothing here calls an LLM itself — the network call lives only inside the
 * host-provided `toolCompletion` (or the SDK's default fetch transport).
 */

import {
  type DreamAgentRunner,
  type ExtractionAgentRunner,
  type ExtractionMessage,
  type MemScribe as SdkMemScribe,
  type ToolCompletion,
  createDreamAgentRunner,
  createExtractionAgentRunner,
  createMemScribe,
} from "@memscribe/sdk";

import type { MemScribe, MemScribeContext, MemScribeMessage } from "./adapter.js";

/**
 * The thin LLM transport a host wraps around its own model channel. Re-exported
 * from the SDK so hosts/adapters depend only on `@memscribe/adapters`.
 *  - `ToolCompletion`: OpenAI-compatible tool-calling channel — drives BOTH the
 *    extraction subagent and the dream consolidation subagent.
 */
export type { ToolCompletion } from "@memscribe/sdk";

/** Options for {@link createHostMemScribe}. */
export interface HostMemScribeOptions {
  /**
   * The host's tool-calling LLM channel. Drives BOTH subagents — extraction and
   * dream consolidation — which write memories directly via core's memory tools.
   * When omitted (and no explicit `agent` / `dreamRunner`), the scribe is
   * recall-only: it injects memory but never extracts, and dream runs only the
   * deterministic structural pre-pass.
   */
  toolCompletion?: ToolCompletion;
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
   * Provide an extraction agent explicitly instead of building one from
   * `toolCompletion`. Takes precedence over `toolCompletion` for extraction.
   */
  agent?: ExtractionAgentRunner;
  /**
   * Provide a dream consolidation subagent explicitly. Defaults to one built
   * from `toolCompletion`; pass `null` to disable semantic consolidation
   * (deterministic structural pre-pass only).
   */
  dreamRunner?: DreamAgentRunner | null;
}

/** The result of {@link createHostMemScribe}: an adapter-ready scribe + the SDK scribe. */
export interface HostMemScribe {
  /** The adapter-facing scribe — pass straight to `adapter.attach(scribe, host)`. */
  scribe: MemScribe;
  /** The underlying SDK scribe, for explicit ops (context/read/save/runDream). */
  sdk: SdkMemScribe;
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
    out.push(hasTools ? { role: m.role, text, toolCalls } : { role: m.role, text });
  }
  return out;
}

/**
 * Adapt an SDK `MemScribe` (hooks take positional args, onPromptBuild returns a
 * BuildContextResult) to the adapter-facing `MemScribe` (hooks take a single
 * payload object). The two recall segments are structurally identical, so the
 * `MemScribeContext` passes through unchanged. `onAgentEnd` is folded into
 * `onSessionEnd` so the adapter lifecycle's session-end runs a final sweep over
 * any not-yet-extracted messages before dropping the session.
 */
export function adaptSdkMemScribe(sdk: SdkMemScribe): MemScribe {
  return {
    async onSessionStart(input: { sessionId: string }): Promise<void> {
      await sdk.onSessionStart(input.sessionId);
    },
    async onPromptBuild(input: { sessionId: string }): Promise<MemScribeContext> {
      const ctx = await sdk.onPromptBuild(input.sessionId);
      return {
        systemPrompt: ctx.systemPrompt,
        preludePrompt: ctx.preludePrompt,
        enabled: ctx.enabled,
      };
    },
    async onTurnEnd(input: { sessionId: string; messages: MemScribeMessage[] }): Promise<void> {
      await sdk.onTurnEnd(input.sessionId, toExtractionMessages(input.messages));
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
 * Build a batteries-included scribe from a host's LLM channel. Wraps
 * `toolCompletion` into both the extraction and dream consolidation subagents,
 * builds the SDK scribe, and returns both the adapter-facing view and the
 * underlying SDK scribe.
 *
 * - With `toolCompletion`: real semantic extraction + consolidation run as
 *   tool-calling subagents on the host's own model, writing memory files directly.
 * - Without `toolCompletion` (and no explicit `agent` / `dreamRunner`):
 *   recall-only — memory is injected on prompt build, turns never extract, and
 *   dream runs only its deterministic structural pre-pass.
 */
export function createHostMemScribe(options: HostMemScribeOptions = {}): HostMemScribe {
  const { toolCompletion, root, enabled, refuseSecrets } = options;

  const agent =
    options.agent ??
    (toolCompletion ? createExtractionAgentRunner({ toolCompletion }) : undefined);

  let dreamRunner: DreamAgentRunner | undefined;
  if (options.dreamRunner === null) {
    dreamRunner = undefined;
  } else if (options.dreamRunner) {
    dreamRunner = options.dreamRunner;
  } else if (toolCompletion) {
    dreamRunner = createDreamAgentRunner({ toolCompletion });
  }

  const sdk = createMemScribe({ root, enabled, agent, dreamRunner, refuseSecrets });
  return { scribe: adaptSdkMemScribe(sdk), sdk };
}
