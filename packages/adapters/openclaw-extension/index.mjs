import { definePluginEntry } from "openclaw/plugin-sdk/core";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import { createOpenClawPluginRuntime, openClawHostMemoryPaths } from "../dist/index.js";

export default definePluginEntry({
  id: "memflywheel",
  name: "MemFlywheel",
  description: "File-native long-term memory and learned skills for OpenClaw.",
  kind: "memory",
  register(api) {
    const nativeModelRuntime = {
      currentConfig: () => api.runtime.config.current(),
      resolveDefaultAgentId,
      prepareForAgent: prepareSimpleCompletionModelForAgent,
      completePrepared: completeWithPreparedSimpleCompletionModel,
    };
    const dispose = createOpenClawPluginRuntime(api, {
      nativeModelRuntime,
      protectedMemoryPaths: openClawHostMemoryPaths(nativeModelRuntime.currentConfig()),
    });
    api.lifecycle?.registerRuntimeLifecycle?.({
      id: "memflywheel-runtime",
      cleanup: () => dispose(),
    });
  },
});
