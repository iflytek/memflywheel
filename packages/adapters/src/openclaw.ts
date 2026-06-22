/**
 * OpenClaw adapter (best-effort — still runnable).
 *
 * Phase 1 does not yet bind OpenClaw's llm-runtime into HostHarnessPort.
 * Consequences:
 *
 *  - Recall + injection are first-class (via hooks + registerMemoryCapability).
 *  - Native extraction/dream/skill loops are disabled until Phase 2 maps
 *    OpenClaw's llm-runtime into a canonical model port.
 *
 * Lifecycle:
 *  - `before_agent_start` → onSessionStart
 *  - `before_agent_start` prompt build (returns prependContext) → onPromptBuild
 *  - `agent_end`          → onTurnEnd (fire-and-forget extraction subagent)
 *  - idle watcher          → onIdle
 *
 * See examples/openclaw for the `register(api)` plugin glue and the optional
 * MCP bridge (@memscribe/mcp-server) for hosts that prefer the tool path.
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "before_agent_start",
    note: "OpenClaw before_agent_start: register memory capability + ensure dir.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "context:inject",
    note: "Context injection: return prependContext = scribe.preludePrompt.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "agent_end",
    note: "agent_end: turn transcript hook; native extraction requires a canonical model port.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "idle:watch",
    note: "Idle watcher triggers gate-checked dream.",
  },
};

export const openclawAdapter: HostAdapter = makeAdapter({
  id: "openclaw",
  name: "OpenClaw",
  lifecycle,
  defaultConfigRelPath: ".openclaw/openclaw.json",
  integrationNote:
    "Phase-1 recall path: OpenClaw hooks can inject memory, but native extraction/skill loops wait for an OpenClaw llm-runtime HostHarnessPort.",
  translators: {
    sessionId: (payload) => readString(payload, "agentId") || readString(payload, "sessionId"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "agentId") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { history?: unknown } | undefined)?.history),
    }),
    idle: (payload) => ({ force: Boolean((payload as { force?: unknown } | undefined)?.force) }),
  },
});
