/**
 * Hermes plugin glue (real integration).
 *
 * A Hermes plugin's `register(ctx)` wraps the host LLM facade
 * (`ctx.llm.acomplete`, with tool calling) into a `toolCompletion`, builds a
 * batteries-included scribe with `createHostMemScribe`, and binds `hermesAdapter` so the
 * scribe's hooks fire on Hermes' real events (on_session_start / pre_llm_call /
 * post_llm_call / on_session_end).
 *
 * Because Hermes owns the credentials, no API key is needed — both subagents
 * (extraction and dream consolidation) run on Hermes' own model through
 * `ctx.llm.acomplete`, over the single `toolCompletion` channel.
 */

import { createHostMemScribe, hermesAdapter } from "@memscribe/adapters";

/** @param {any} ctx - the Hermes PluginContext */
export function register(ctx) {
  // The extraction subagent is a tool-calling loop: wrap Hermes' model as a
  // ToolCompletion that passes the advertised tools through and returns the
  // assistant message (content and/or tool_calls) plus a finish reason.
  const toolCompletion = async ({ messages, tools, signal }) => {
    const result = await ctx.llm.acomplete(messages, { tools, signal });
    const message = result?.message ?? {
      role: "assistant",
      content: result?.text ?? "",
    };
    return { message, finishReason: result?.finish_reason ?? message.finishReason };
  };

  // One channel drives BOTH subagents: extraction and dream consolidation.
  const { scribe } = createHostMemScribe({ toolCompletion });

  // Hermes exposes register_hook(name, cb); the adapter's `attach` expects an
  // `on(event, listener)` surface, so bridge Hermes hooks into it.
  const host = {
    on(event, listener) {
      ctx.register_hook(event, (kwargs) => listener(kwargs));
      return undefined; // Hermes manages hook lifetime
    },
  };

  return hermesAdapter.attach(scribe, host);
}
