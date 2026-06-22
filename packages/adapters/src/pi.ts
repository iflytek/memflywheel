/**
 * Pi adapter — the Pi kernel (real integration).
 *
 * Pi loads top-level `.js` extensions from an extensions directory plus a
 * `settings.json` `extensions` array. An extension module receives the Pi
 * ExtensionAPI and binds its per-session hooks; this adapter maps those onto the
 * scribe:
 *
 *  - `session_start`     → onSessionStart
 *  - `context`           → onPromptBuild, returning `{ messages }` to prepend recall
 *  - `agent_end`         → onTurnEnd
 *  - `session_shutdown`  → onSessionEnd
 *
 * `createPiHarnessPort` maps Pi's native model/lifecycle/telemetry surface into
 * the canonical HostHarnessPort. The extraction subagent then runs on Pi's own
 * model and writes memory files directly via ordinary file tools.
 */

import { makeAdapter, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";
import { attachPiScribe, memScribeMessagesFromPi, type PiExtensionApiLike } from "./pi-port.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "session_start",
    note: "Pi session_start: initialize the MemScribe session state.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "context",
    note: "Pi context hook: prepend MemScribe recall as a returned context message.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "agent_end",
    note: "Pi agent_end with post-turn messages — async extraction subagent over the host-owned model.",
  },
  onSessionEnd: {
    hook: "onSessionEnd",
    hostEvent: "session_shutdown",
    note: "Pi session_shutdown: final extraction sweep and session cleanup.",
  },
};

const basePiAdapter = makeAdapter({
  id: "pi",
  name: "Pi kernel",
  lifecycle,
  defaultConfigRelPath: ".pi/agent/settings.json",
  integrationNote:
    "Native integration: a Pi extension builds `createPiHarnessPort(pi, { completeSimple })` and passes it to `createMemScribeHarnessRuntime`; settings.json carries the wiring marker.",
  translators: {
    sessionId: (payload) => readString(payload, "sessionId"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "sessionId"),
      messages: memScribeMessagesFromPi((payload as { messages?: unknown } | undefined)?.messages),
    }),
  },
});

export const piAdapter: HostAdapter = {
  ...basePiAdapter,
  attach(scribe, host) {
    return attachPiScribe(scribe, host as PiExtensionApiLike);
  },
};
