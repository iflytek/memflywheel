/**
 * Hermes plugin glue (real integration).
 *
 * A Hermes plugin's `register(ctx)` maps the host LLM facade into the canonical
 * model transport, builds a MemFlywheel harness runtime, and binds `hermesAdapter`
 * so the scribe's hooks fire on Hermes' real events.
 *
 * Because Hermes owns the credentials, no API key is needed — both subagents
 * (extraction and dream consolidation) run on Hermes' own model through
 * the host's active model transport, over the single Pi Agent Core runner.
 */

import { createMemFlywheelHarnessRuntime, hermesAdapter } from "@iflytekopensource/memflywheel";

/** @param {any} ctx - the Hermes PluginContext */
export function register(ctx) {
  const model = {
    async complete(req) {
      if (typeof ctx.llm?.completeWithTools !== "function") {
        throw new Error("Hermes MemFlywheel integration requires ctx.llm.completeWithTools");
      }
      return ctx.llm.completeWithTools(req);
    },
  };

  const { scribe } = createMemFlywheelHarnessRuntime({ model });

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
