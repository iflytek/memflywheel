import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createOpenClawPluginRuntime } from "../dist/index.js";

export default definePluginEntry({
  id: "memflywheel",
  name: "MemFlywheel",
  description: "File-native long-term memory and learned skills for OpenClaw.",
  kind: "memory",
  register(api) {
    const dispose = createOpenClawPluginRuntime(api);
    api.lifecycle?.registerRuntimeLifecycle?.({
      id: "memflywheel-runtime",
      cleanup: () => dispose(),
    });
  },
});
