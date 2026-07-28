/**
 * Pi extension entry point for K8s e2e test.
 *
 * Identical to examples/pi/extension.mjs but with graceful shutdown:
 * the dispose handler awaits pending extraction promises so that
 * `pi --print` waits for extraction before exiting.
 */

import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  createMemFlywheelHarnessRuntime,
  createPiHarnessPort,
} from "@iflytekopensource/memflywheel";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memFlywheelExtension(pi) {
  const pendingPromises = new Set();

  // Wrap streamSimple to track extraction model calls
  const trackedStreamSimple = (model, context, options) => {
    const stream = streamSimple(model, context, options);
    const promise = stream.result();
    pendingPromises.add(promise);
    promise.finally(() => pendingPromises.delete(promise));
    return stream;
  };

  const port = createPiHarnessPort(pi, { streamSimple: trackedStreamSimple });
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
