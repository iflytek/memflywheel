/**
 * Pi adapter — the Pi kernel (real integration).
 *
 * Pi loads top-level `.js` extensions from an extensions directory plus a
 * `settings.json` `extensions` array. An extension module receives the Pi
 * ExtensionAPI and binds its per-session hooks; this adapter maps those onto the
 * scribe:
 *
 *  - session create/config (per-session ModelRegistry + systemPrompt) → onSessionStart
 *  - per-turn knowledge assembly                                       → onPromptBuild
 *      (scribe.systemPrompt merges into the per-session system prompt;
 *       scribe.preludePrompt is prepended to the prelude prompts — cache-friendly)
 *  - turn-done (`agent_end` / post-turn context)                       → onTurnEnd (fire-and-forget)
 *  - learning-loop idle tick                                            → onIdle
 *
 * `createPiHarnessPort` maps Pi's native model/lifecycle/telemetry surface into
 * the canonical HostHarnessPort. The extraction subagent then runs on Pi's own
 * model and writes memory files directly via ordinary file tools.
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "session:ensure",
    note: "Pi session create/config: per-session ModelRegistry + systemPrompt.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "turn:build",
    note: "Per-turn assembly: merge scribe.systemPrompt into systemPrompt, prepend prelude to preludePrompts.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "agent_end",
    note: "Pi agent_end with post-turn context — async extraction subagent, never blocks the stream.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "learning:idle",
    note: "Pi learning-loop idle tick triggers dream consolidation.",
  },
};

export const piAdapter: HostAdapter = makeAdapter({
  id: "pi",
  name: "Pi kernel",
  lifecycle,
  defaultConfigRelPath: ".pi/agent/settings.json",
  integrationNote:
    "Native integration: a Pi extension builds `createPiHarnessPort(pi)` and passes it to `createMemScribeHarnessRuntime`; settings.json carries the wiring marker.",
  translators: {
    sessionId: (payload) => readString(payload, "sessionId"),
    turnEnd: (payload) => ({
      sessionId: readString(payload, "sessionId"),
      // Pi's post-turn context carries the turn transcript under `messages`.
      messages: normalizeMessages((payload as { messages?: unknown } | undefined)?.messages),
    }),
    idle: () => undefined,
  },
});
