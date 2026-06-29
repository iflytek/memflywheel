import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "../dist/index.js";

export default function memFlywheelExtension(pi) {
  const port = createPiHarnessPort(pi, { completeSimple });
  const runtime = createMemFlywheelHarnessRuntime({ port });

  if (typeof pi.onDispose === "function") pi.onDispose(runtime.dispose);
  return runtime.dispose;
}
