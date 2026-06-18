/**
 * OpenClaw plugin glue (best-effort, still runnable).
 *
 * OpenClaw exposes no in-process model-call API, so the plugin cannot drive
 * inference itself. Recall + injection are first-class via hooks +
 * registerMemoryCapability; the extraction subagent runs on MemScribe's own
 * default fetch tool-completion (the user provides MEMSCRIBE_LLM_API_KEY).
 *
 * `register(api)`:
 *  - claims the memory slot via registerMemoryCapability,
 *  - builds the scribe with the env-driven default extraction subagent,
 *  - binds `openclawAdapter` to OpenClaw's hooks.
 */

import { createHostMemScribe, openclawAdapter } from "@memscribe/adapters";
import { defaultExtractionAgentFromEnv } from "@memscribe/sdk";

const plugin = {
  id: "memscribe",
  name: "MemScribe",

  /** @param {any} api - the OpenClaw plugin API */
  register(api) {
    // The extraction subagent uses the default fetch tool-completion (no host
    // model-call API).
    const { scribe } = createHostMemScribe({ agent: defaultExtractionAgentFromEnv() });

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
