/**
 * OpenClaw adapter.
 *
 * Lifecycle:
 *  - `before_prompt_build` → onPromptBuild
 *  - `agent_end`           → onTurnEnd
 *  - `session_end`         → session flush in the native plugin port
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "session_start",
    note: "OpenClaw session_start records the current session.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "before_prompt_build",
    note: "before_prompt_build injects memory and learned-skill context.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "agent_end",
    note: "agent_end forwards the turn transcript to MemFlywheel.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "session_end",
    note: "The native plugin port flushes session-end state.",
  },
};

export const openclawAdapter: HostAdapter = makeAdapter({
  id: "openclaw",
  name: "OpenClaw",
  lifecycle,
  defaultConfigRelPath: ".openclaw/openclaw.json",
  integrationNote:
    "Native OpenClaw hooks inject recall and read transcripts; MemFlywheel extraction/skill loops use the configured OpenAI-compatible model endpoint.",
  translators: {
    sessionId: (payload) => readString(payload, "agentId") || readString(payload, "sessionId"),
    promptQuery: (payload) =>
      readString(payload, "prompt") ||
      readString(payload, "query") ||
      readString(payload, "message"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "agentId") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { history?: unknown } | undefined)?.history),
    }),
    idle: (payload) => ({ force: Boolean((payload as { force?: unknown } | undefined)?.force) }),
  },
});
