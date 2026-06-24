/**
 * Pi extension entry point (real integration).
 *
 * Pi loads top-level `.js`/`.mjs` extensions and calls the module's default
 * export with the ExtensionAPI. This module maps Pi into HostHarnessPort and
 * builds a MemFlywheel harness runtime. The runtime auto-attaches to Pi's real
 * events: context / agent_end / session_shutdown / tool_call / tool_result.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "@memflywheel/adapters";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memFlywheelExtension(pi) {
  const port = createPiHarnessPort(pi, { completeSimple });
  const runtime = createMemFlywheelHarnessRuntime({ port });

  // Pi disposes extensions on shutdown; return the disposer when supported.
  if (typeof pi.onDispose === "function") pi.onDispose(runtime.dispose);
  return runtime.dispose;
}
