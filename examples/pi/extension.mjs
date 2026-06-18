/**
 * Pi extension entry point (real integration).
 *
 * Pi loads top-level `.js`/`.mjs` extensions and calls the module's default
 * export with the ExtensionAPI. This module wraps Pi's per-session auxiliary
 * tool-calling completion into a `toolCompletion`, builds a batteries-included
 * scribe with `createHostMemScribe`, and attaches `piAdapter` to the Pi host so the
 * four lifecycle hooks fire on Pi's events.
 *
 * In a real Pi process, `pi.auxiliaryComplete(...)` is the small dedicated
 * session used for background model calls; the extraction subagent runs there so
 * the main stream is never touched.
 */

import { createHostMemScribe, piAdapter } from "@memscribe/adapters";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memScribeExtension(pi) {
  // The extraction subagent is a tool-calling loop. Wrap Pi's auxiliary
  // completion as a ToolCompletion: pass the advertised tools through and return
  // the assistant message (content and/or tool_calls) plus a finish reason.
  const toolCompletion = async ({ messages, tools, signal }) => {
    const result = await pi.auxiliaryComplete({ messages, tools, signal });
    const message = result?.message ?? {
      role: "assistant",
      content: typeof result === "string" ? result : (result?.text ?? ""),
    };
    return { message, finishReason: result?.finish_reason ?? message.finishReason };
  };

  // One channel drives BOTH subagents: extraction and dream consolidation.
  const { scribe } = createHostMemScribe({ toolCompletion });
  const dispose = piAdapter.attach(scribe, pi);

  // Pi disposes extensions on shutdown; return the disposer when supported.
  if (typeof pi.onDispose === "function") pi.onDispose(dispose);
  return dispose;
}
