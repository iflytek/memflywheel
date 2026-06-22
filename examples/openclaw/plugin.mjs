/**
 * OpenClaw plugin glue (best-effort, still runnable).
 *
 * OpenClaw native model-loop support is not wired in phase 1. The plugin claims
 * recall/injection only; a later OpenClaw adapter must map llm-runtime into
 * HostHarnessPort before MemScribe can run extraction/dream/skill loops natively.
 *
 * `register(api)`:
 *  - claims the memory slot via registerMemoryCapability,
 *  - builds the scribe in explicit recall-only mode,
 *  - binds `openclawAdapter` to OpenClaw's hooks.
 */

import { createMemScribeHarnessRuntime, openclawAdapter } from "@memscribe/adapters";

const plugin = {
  id: "memscribe",
  name: "MemScribe",

  /** @param {any} api - the OpenClaw plugin API */
  register(api) {
    const { scribe } = createMemScribeHarnessRuntime({ mode: "recall-only" });

    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability({
        promptBuilder: () => [
          "Long-term memory provider: MemScribe (file-native memory).",
          "Stored memories are injected on prompt build.",
        ],
      });
    }

    // OpenClaw hooks return { prependContext } on the prompt-build event; the
    // adapter delivers the scribe context through the `respond` callback when the
    // host attaches one to the payload.
    const host = {
      on(event, listener) {
        return api.on(event, (payload) => listener(payload));
      },
    };

    return openclawAdapter.attach(scribe, host);
  },
};

export default plugin;
