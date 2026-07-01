/**
 * OpenCode adapter.
 *
 *  - chat/system transform       → onPromptBuild
 *  - session.idle + messages API → onTurnEnd
 *  - session.deleted             → onSessionEnd
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "chat.message",
    note: "OpenCode chat.message records the current session.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "experimental.chat.system.transform",
    note: "System transform injects memory and learned-skill context.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "session.idle",
    note: "Idle event reads the official session messages API and runs extraction.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "session.deleted",
    note: "Session deletion flushes session-end state.",
  },
};

export const opencodeAdapter: HostAdapter = makeAdapter({
  id: "opencode",
  name: "OpenCode",
  lifecycle,
  defaultConfigRelPath: ".config/opencode/opencode.json",
  integrationNote:
    "Native OpenCode plugin hooks inject recall and read transcripts; MemFlywheel extraction/skill loops use the configured OpenAI-compatible model endpoint.",
  translators: {
    sessionId: (payload) => readString(payload, "sessionID") || readString(payload, "sessionId"),
    promptQuery: (payload) =>
      readString(payload, "prompt") ||
      readString(payload, "query") ||
      readString(payload, "message"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "sessionID") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { messages?: unknown } | undefined)?.messages),
    }),
    idle: () => undefined,
  },
});
