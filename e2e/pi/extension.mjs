/**
 * Pi extension entry point for K8s e2e test.
 *
 * Identical to examples/pi/extension.mjs but with graceful shutdown:
 * the dispose handler awaits pending extraction promises so that
 * `pi --print` waits for extraction before exiting.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "@iflytekopensource/adapters";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memFlywheelExtension(pi) {
  const pendingPromises = new Set();

  // Wrap completeSimple to track extraction model calls
  const trackedCompleteSimple = (model, context, options) => {
    const promise = completeSimple(model, context, options);
    pendingPromises.add(promise);
    promise.finally(() => pendingPromises.delete(promise));
    return promise;
  };

  const port = createPiHarnessPort(pi, { completeSimple: trackedCompleteSimple });
  const runtime = createMemFlywheelHarnessRuntime({ port });

  const originalDispose = runtime.dispose;
  const dispose = async () => {
    // Wait for all pending extraction/model calls to finish
    if (pendingPromises.size > 0) {
      await Promise.allSettled([...pendingPromises]);
    }
    originalDispose();
  };

  if (typeof pi.onDispose === "function") pi.onDispose(dispose);
  return dispose;
}
