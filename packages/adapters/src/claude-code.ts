/**
 * Claude Code adapter.
 *
 *  - SessionStart hook        → onSessionStart
 *  - UserPromptSubmit hook     → onPromptBuild (inject prelude before the prompt)
 *  - Stop / turn-end hook       → onTurnEnd
 *  - idle / cron                → onIdle
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "SessionStart",
    note: "Claude Code SessionStart hook.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "UserPromptSubmit",
    note: "UserPromptSubmit hook: inject <system-reminder> prelude before the prompt.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "Stop",
    note: "Stop / turn-end hook: fire-and-forget extraction.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "Idle",
    note: "Idle / cron triggers dream.",
  },
};

export const claudeCodeAdapter: HostAdapter = makeAdapter({
  id: "claude-code",
  name: "Claude Code",
  lifecycle,
  defaultConfigRelPath: ".claude/settings.json",
  integrationNote: "Usable: hook-driven wiring marker; the extraction subagent uses the default fetch tool-completion (no in-process model-call API).",
  translators: {
    sessionId: (payload) => readString(payload, "session_id") || readString(payload, "sessionId"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "session_id") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { messages?: unknown } | undefined)?.messages),
    }),
    idle: () => undefined,
  },
});
