/**
 * OpenCode adapter.
 *
 *  - session init               → onSessionStart
 *  - message build middleware    → onPromptBuild
 *  - response complete event     → onTurnEnd
 *  - background timer            → onIdle
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "session.init",
    note: "OpenCode session init.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "message.build",
    note: "Message build middleware: merge systemPrompt, inject prelude.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "response.complete",
    note: "Response complete event: fire-and-forget extraction.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "timer.background",
    note: "Background timer triggers dream.",
  },
};

export const opencodeAdapter: HostAdapter = makeAdapter({
  id: "opencode",
  name: "OpenCode",
  lifecycle,
  defaultConfigRelPath: ".config/opencode/opencode.json",
  integrationNote: "Usable: plugin middleware wiring marker; pass a host `toolCompletion` or the default fetch tool-completion to createHostMemScribe.",
  translators: {
    sessionId: (payload) => readString(payload, "sessionID") || readString(payload, "sessionId"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "sessionID") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { messages?: unknown } | undefined)?.messages),
    }),
    idle: () => undefined,
  },
});
