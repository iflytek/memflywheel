/**
 * OpenClaw adapter (best-effort — still runnable).
 *
 * OpenClaw's plugin API lets a plugin read the prompt/messages via hooks and
 * inject context, but does NOT expose a direct model-call interface — a plugin
 * cannot itself drive inference. Consequences:
 *
 *  - Recall + injection are first-class (via hooks + registerMemoryCapability).
 *  - Extraction cannot use the host model; the subagent runs on MemScribe's own
 *    default fetch tool-completion (the user provides MEMSCRIBE_LLM_API_KEY).
 *    Pass `defaultExtractionAgentFromEnv()` to createHostMemScribe.
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
    note: "agent_end: fire-and-forget extraction subagent via the default fetch tool-completion.",
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
    "Best-effort (still runnable): OpenClaw exposes no model-call API, so the extraction subagent uses MemScribe's default fetch tool-completion (MEMSCRIBE_LLM_API_KEY). Recall + injection are first-class via hooks; an MCP bridge is also available.",
  translators: {
    sessionId: (payload) => readString(payload, "agentId") || readString(payload, "sessionId"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "agentId") || readString(payload, "sessionId"),
      messages: normalizeMessages((payload as { history?: unknown } | undefined)?.history),
    }),
    idle: (payload) => ({ force: Boolean((payload as { force?: unknown } | undefined)?.force) }),
  },
});
