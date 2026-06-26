/**
 * Hermes adapter (real integration).
 *
 * A Hermes plugin's `register(ctx)` maps the host LLM facade into the canonical
 * model protocol and binds the scribe to Hermes' real hooks:
 *
 *  - `on_session_start` → onSessionStart
 *  - `pre_llm_call`     → onPromptBuild  (inject prelude as {"context": ...} into
 *                          the user message; merge systemPrompt once at session
 *                          start to preserve the prompt-cache prefix)
 *  - `post_llm_call`    → onTurnEnd      (fire-and-forget extraction; fires after
 *                          the tool loop completes, transcript is final)
 *  - `on_session_end`   → onIdle         (per-turn end point; gate-checked dream)
 *
 * See examples/hermes for the `register(ctx)` glue that requires
 * `ctx.llm.completeWithTools`.
 */

import { makeAdapter, normalizeMessages, readString } from "./make-adapter.js";
import type { HostAdapter, LifecycleMap } from "./adapter.js";

const lifecycle: LifecycleMap = {
  onSessionStart: {
    hook: "onSessionStart",
    hostEvent: "on_session_start",
    note: "Hermes on_session_start: init cursor + ensure memory dir.",
  },
  onPromptBuild: {
    hook: "onPromptBuild",
    hostEvent: "pre_llm_call",
    note: "pre_llm_call: merge systemPrompt, inject prelude as {context} before the user message.",
  },
  onTurnEnd: {
    hook: "onTurnEnd",
    hostEvent: "post_llm_call",
    note: "post_llm_call: fire-and-forget extraction subagent after the tool loop completes.",
  },
  onIdle: {
    hook: "onIdle",
    hostEvent: "on_session_end",
    note: "on_session_end (per-turn): gate-checked dream consolidation.",
  },
};

export const hermesAdapter: HostAdapter = makeAdapter({
  id: "hermes",
  name: "Hermes",
  lifecycle,
  defaultConfigRelPath: ".hermes/config.json",
  integrationNote:
    "Real integration path: a Hermes plugin must expose `ctx.llm.completeWithTools` as a canonical model; the plugin config block carries the wiring marker.",
  translators: {
    sessionId: (payload) =>
      readString(payload, "session_id") ||
      readString(payload, "conversationId") ||
      readString(payload, "sessionId"),
    promptQuery: (payload) =>
      readString(payload, "user_message") ||
      readString(payload, "prompt") ||
      readString(payload, "query"),
    turnEnd: (payload) => {
      const sessionId =
        readString(payload, "session_id") ||
        readString(payload, "conversationId") ||
        readString(payload, "sessionId");
      // Hermes post_llm_call exposes user_message + assistant_response; fall back
      // to an explicit transcript array when the host pre-assembles one.
      const obj = (payload ?? {}) as Record<string, unknown>;
      if (Array.isArray(obj.transcript)) {
        return { sessionId, messages: normalizeMessages(obj.transcript) };
      }
      const messages = normalizeMessages([
        { role: "user", text: readString(payload, "user_message") },
        { role: "assistant", text: readString(payload, "assistant_response") },
      ]);
      return { sessionId, messages };
    },
    idle: (payload) => ({ force: Boolean((payload as { force?: unknown } | undefined)?.force) }),
  },
});
