/**
 * Hermes plugin glue (real integration).
 *
 * A Hermes plugin's `register(ctx)` maps the host LLM facade into the canonical
 * model protocol, builds a MemScribe harness runtime, and binds `hermesAdapter`
 * so the scribe's hooks fire on Hermes' real events.
 *
 * Because Hermes owns the credentials, no API key is needed — both subagents
 * (extraction and dream consolidation) run on Hermes' own model through
 * `ctx.llm.completeWithTools`, over the single canonical model channel.
 */

import { createMemScribeHarnessRuntime, hermesAdapter } from "@memscribe/adapters";

/** @param {any} ctx - the Hermes PluginContext */
export function register(ctx) {
  const model = {
    async complete(req) {
      if (typeof ctx.llm?.completeWithTools !== "function") {
        throw new Error("Hermes MemScribe integration requires ctx.llm.completeWithTools");
      }
      return ctx.llm.completeWithTools(req);
    },
  };

  const { scribe } = createMemScribeHarnessRuntime({ model });

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
