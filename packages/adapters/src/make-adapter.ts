/**
 * Factory that assembles a `HostAdapter` from a host's lifecycle map and a set
 * of payload translators. All install/verify/doctor logic is shared (see
 * adapter.ts); per-host files only declare WHICH host event maps to WHICH scribe
 * hook and HOW to read the host's payload shape.
 */

import {
  type HostAdapter,
  type HostRuntime,
  type HookTranslators,
  type InstallPlan,
  type InstallResult,
  type InstallTarget,
  type LifecycleMap,
  type MemScribe,
  type MemScribeMessage,
  type MemScribeToolCall,
  applyInstall,
  bindLifecycle,
  doctorInstall,
  planInstall,
  verifyInstall,
} from "./adapter.js";

export interface AdapterSpec {
  id: string;
  name: string;
  lifecycle: LifecycleMap;
  translators: HookTranslators;
  /** Host config path relative to the home directory (for `connect <host>`). */
  defaultConfigRelPath?: string;
  /** One-line integration note (carries the "best-effort" caveat when needed). */
  integrationNote?: string;
}

/** Build a fully-wired `HostAdapter` from a per-host spec. */
export function makeAdapter(spec: AdapterSpec): HostAdapter {
  return {
    id: spec.id,
    name: spec.name,
    lifecycle: spec.lifecycle,
    defaultConfigRelPath: spec.defaultConfigRelPath,
    integrationNote: spec.integrationNote,

    attach(scribe: MemScribe, host: HostRuntime): () => void {
      return bindLifecycle(scribe, host, spec.lifecycle, spec.translators);
    },

    async install(
      target: InstallTarget,
      opts?: { apply?: boolean },
    ): Promise<InstallPlan | InstallResult> {
      if (opts?.apply) return applyInstall(this, target);
      return planInstall(this, target);
    },

    verify(target: InstallTarget) {
      return verifyInstall(this, target);
    },

    doctor(target: InstallTarget) {
      return doctorInstall(this, target);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared translator helpers — most hosts share these payload shapes.
// ---------------------------------------------------------------------------

/** Read a string field from an unknown payload, or "" if absent. */
export function readString(payload: unknown, key: string): string {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return "";
}

type RawObj = Record<string, unknown>;

/** True unless explicitly disabled via MEMSCRIBE_FOLD_TOOL_CALLS=0/false. Default on. */
function foldEnabled(): boolean {
  const v = process.env.MEMSCRIBE_FOLD_TOOL_CALLS;
  return v !== "0" && v !== "false";
}

/** Plain text from a message `content` (string, or Anthropic block array's text blocks). */
function extractText(content: unknown, topText: unknown): string {
  if (typeof topText === "string" && topText) return topText;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as RawObj;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Text of a tool-result payload (string, block array, or {text}). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object" && typeof (block as RawObj).text === "string") {
        parts.push((block as RawObj).text as string);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object" && typeof (content as RawObj).text === "string") {
    return (content as RawObj).text as string;
  }
  return "";
}

/**
 * Normalize an arbitrary transcript array into MemScribeMessages: keep user/assistant
 * roles, coerce text, drop empties. When folding is enabled (default), tool calls
 * are folded into the assistant turn that made them, paired with their result —
 * supporting both the OpenAI shape (assistant `tool_calls` + `role:"tool"` replies)
 * and the Anthropic shape (`tool_use` / `tool_result` content blocks). The folded
 * tool text is later truncated by core's renderer (input 200 / output 500 head+tail
 * + window cap), so a huge tool output cannot bloat the extraction prompt.
 */
export function normalizeMessages(raw: unknown): MemScribeMessage[] {
  if (!Array.isArray(raw)) return [];
  const fold = foldEnabled();

  // Pass 1: index tool outputs by call id (OpenAI role:tool + Anthropic tool_result blocks).
  const outputs = new Map<string, string>();
  if (fold) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      const obj = m as RawObj;
      if (obj.role === "tool" && typeof obj.tool_call_id === "string") {
        outputs.set(obj.tool_call_id, resultText(obj.content));
      }
      if (Array.isArray(obj.content)) {
        for (const block of obj.content) {
          if (block && typeof block === "object" && (block as RawObj).type === "tool_result") {
            const b = block as RawObj;
            const id =
              typeof b.tool_use_id === "string"
                ? b.tool_use_id
                : typeof b.tool_call_id === "string"
                  ? b.tool_call_id
                  : "";
            if (id) outputs.set(id, resultText(b.content));
          }
        }
      }
    }
  }

  // Pass 2: build MemScribeMessages, folding tool_use/tool_calls into the assistant turn.
  const out: MemScribeMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const obj = m as RawObj;
    const role = obj.role;
    if (role !== "user" && role !== "assistant") continue; // role:"tool" consumed in pass 1

    const text = extractText(obj.content, obj.text).trim();

    let toolCalls: MemScribeToolCall[] | undefined;
    if (fold && role === "assistant") {
      const collected: MemScribeToolCall[] = [];
      // OpenAI shape: top-level tool_calls.
      if (Array.isArray(obj.tool_calls)) {
        for (const c of obj.tool_calls) {
          if (!c || typeof c !== "object") continue;
          const call = c as RawObj;
          const fn = call.function as RawObj | undefined;
          const name =
            fn && typeof fn.name === "string"
              ? fn.name
              : typeof call.name === "string"
                ? call.name
                : "";
          if (!name) continue;
          let input: unknown;
          if (fn && typeof fn.arguments === "string") {
            try {
              input = JSON.parse(fn.arguments);
            } catch {
              input = fn.arguments;
            }
          } else if ("input" in call) {
            input = call.input;
          }
          const id = typeof call.id === "string" ? call.id : "";
          collected.push({ name, input, output: id ? outputs.get(id) : undefined });
        }
      }
      // Anthropic shape: tool_use blocks in the content array.
      if (Array.isArray(obj.content)) {
        for (const block of obj.content) {
          if (block && typeof block === "object" && (block as RawObj).type === "tool_use") {
            const b = block as RawObj;
            const name = typeof b.name === "string" ? b.name : "";
            if (!name) continue;
            const id = typeof b.id === "string" ? b.id : "";
            collected.push({ name, input: b.input, output: id ? outputs.get(id) : undefined });
          }
        }
      }
      if (collected.length > 0) toolCalls = collected;
    }

    if (text === "" && !toolCalls) continue;
    out.push(toolCalls ? { role, text, toolCalls } : { role, text });
  }
  return out;
}
