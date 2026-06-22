/**
 * Pi extension entry point (real integration).
 *
 * Pi loads top-level `.js`/`.mjs` extensions and calls the module's default
 * export with the ExtensionAPI. This module maps Pi into HostHarnessPort, builds
 * a MemScribe harness runtime, and attaches `piAdapter` so lifecycle hooks fire
 * on Pi's events.
 *
 * In a real Pi process, `pi.completeSimple(...)` / equivalent host-owned model
 * access is used for background MemScribe calls; MemScribe never owns provider
 * credentials.
 */

import { createMemScribeHarnessRuntime, createPiHarnessPort, piAdapter } from "@memscribe/adapters";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memScribeExtension(pi) {
  const port = createPiHarnessPort(pi);
  const { scribe } = createMemScribeHarnessRuntime({ port });
  const dispose = piAdapter.attach(scribe, pi);

  // Pi disposes extensions on shutdown; return the disposer when supported.
  if (typeof pi.onDispose === "function") pi.onDispose(dispose);
  return dispose;
}
