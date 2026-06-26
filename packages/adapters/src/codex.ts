/**
 * Codex adapter.
 *
 *  - task start            → onSessionStart
 *  - instruction assembly   → onPromptBuild
 *  - task complete          → onTurnEnd
 *  - scheduled job          → onIdle
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "task:start",
    note: "Codex task start.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "instructions:assemble",
    note: "Instruction assembly: merge systemPrompt, inject prelude.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "task:complete",
    note: "Task complete: fire-and-forget extraction.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "job:scheduled",
    note: "Scheduled job triggers dream.",
  },
};

export const codexAdapter: HostAdapter = makeAdapter({
  id: "codex",
  name: "Codex",
  lifecycle,
  defaultConfigRelPath: ".codex/config.json",
  integrationNote:
    "Lifecycle wiring marker only until Codex exposes a host-owned canonical model port.",
  translators: {
    sessionId: (payload) => readString(payload, "taskId") || readString(payload, "sessionId"),
    promptQuery: (payload) =>
      readString(payload, "prompt") ||
      readString(payload, "query") ||
      readString(payload, "message"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "taskId") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { messages?: unknown } | undefined)?.messages),
    }),
    idle: () => undefined,
  },
});
