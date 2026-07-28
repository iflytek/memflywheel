import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { PiAgentModelBinding, ResolvePiAgentModel } from "@memflywheel/sdk";

import {
  createCapabilitySet,
  type Dispose,
  type HostCapability,
  type HostHarnessPort,
  type HostMessage,
  type HostPromptBuildResult,
} from "./harness-port.js";
import type { MemFlywheelMessage } from "./adapter.js";

type PiDispose = Dispose | void;

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiImageContent {
  type: "image";
  [key: string]: unknown;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiUserMessage {
  role: "user";
  content: string | Array<PiTextContent | PiImageContent>;
  timestamp?: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<PiTextContent | PiImageContent | { type: string; [key: string]: unknown }>;
  isError?: boolean;
  timestamp?: number;
}

export type PiAssistantMessage = AssistantMessage;

export type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export interface PiModelAuthResult {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
}

export interface PiExtensionContextLike {
  mode?: "tui" | "rpc" | "json" | "print";
  cwd?: string;
  model?: unknown;
  signal?: AbortSignal;
  sessionManager?: {
    getSessionId?(): string;
  };
  modelRegistry?: {
    getApiKeyAndHeaders?(model: unknown): Promise<PiModelAuthResult>;
  };
  getThinkingLevel?(): unknown;
  isIdle?(): boolean;
}

export type PiExtensionHandler = (
  event: unknown,
  ctx?: PiExtensionContextLike,
) => unknown | Promise<unknown>;

export interface PiExtensionApiLike {
  on(event: string, handler: PiExtensionHandler): PiDispose;
  off?(event: string, handler: PiExtensionHandler): void;
}

export type PiStreamSimple = PiAgentModelBinding["streamFn"];

export type PiSessionIdResolver =
  string | ((input: { event?: unknown; context?: PiExtensionContextLike }) => string | undefined);

export type PiLifecycleAfterHook = () => void | Promise<void>;

export interface CreatePiAgentModelResolverOptions {
  streamSimple: PiStreamSimple;
  /** Explicit Pi model; when absent, the current ExtensionContext model is used. */
  model?: unknown;
  /** Latest Pi ExtensionContext, captured by lifecycle events. */
  getContext?: () => PiExtensionContextLike | undefined;
  /** Optional stable session id used for provider/session affinity. */
  getSessionId?: () => string | undefined;
}

export interface CreatePiHarnessPortOptions {
  resolveModel?: ResolvePiAgentModel;
  /** Use Pi's native streamSimple(model, context, options) function. */
  streamSimple?: PiStreamSimple;
  /** Explicit Pi model for background MemFlywheel loops. Defaults to ctx.model. */
  piModel?: unknown;
  /** Resolve the MemFlywheel session id from Pi event/context. Defaults to Pi session id, else "pi". */
  sessionId?: PiSessionIdResolver;
  /**
   * Optional idle polling. Pi exposes ctx.isIdle(), not an idle event; enabling
   * this opts into a real polling bridge instead of claiming a non-existent hook.
   */
  idleIntervalMs?: number;
  afterPromptBuild?: PiLifecycleAfterHook;
  afterTurnEnd?: PiLifecycleAfterHook;
  afterSessionEnd?: PiLifecycleAfterHook;
}

export interface PiScribeLike {
  onSessionStart(input: { sessionId: string }): Promise<void>;
  onPromptBuild(input: { sessionId: string; query?: string }): Promise<{
    systemPrompt?: string;
    preludePrompt?: string;
    skillPreludePrompt?: string;
    enabled?: boolean;
  }>;
  onTurnEnd(input: { sessionId: string; messages: MemFlywheelMessage[] }): Promise<unknown>;
  onSessionEnd(input: { sessionId: string }): Promise<void>;
  onIdle?(input?: { force?: boolean }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const out = value[key];
  return typeof out === "string" && out.trim() ? out : undefined;
}

function promptQueryFromPiEvent(event: unknown): string | undefined {
  const explicit =
    readString(event, "query") ??
    readString(event, "prompt") ??
    readString(event, "input") ??
    readString(event, "message");
  if (explicit) return explicit;
  const messages = isRecord(event) && Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = textFromPiContent(message.content)?.trim();
    if (text) return text;
  }
  return undefined;
}

function textFromPiContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(
      (part): part is PiTextContent =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text);
  return parts.length > 0 ? parts.join("") : null;
}

function resolvePiSessionId(
  resolver: PiSessionIdResolver | undefined,
  event?: unknown,
  context?: PiExtensionContextLike,
): string {
  if (typeof resolver === "string" && resolver.trim()) return resolver;
  if (typeof resolver === "function") {
    const resolved = resolver({ event, context });
    if (typeof resolved === "string" && resolved.trim()) return resolved;
  }
  return readString(event, "sessionId") ?? context?.sessionManager?.getSessionId?.() ?? "pi";
}

function isolatedBackgroundModelSessionId(hostSessionId: string | undefined): string | undefined {
  return hostSessionId ? `memflywheel:${hostSessionId}` : undefined;
}

function piUserMessage(content: string): PiUserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  };
}

export function hostMessagesFromPi(messages: unknown): HostMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: HostMessage[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === "toolResult") {
      out.push({
        role: "tool",
        toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
        content: textFromPiContent(raw.content),
      });
      continue;
    }
    if (raw.role !== "user" && raw.role !== "assistant") continue;
    const toolCalls =
      raw.role === "assistant" && Array.isArray(raw.content)
        ? raw.content
            .filter(
              (part): part is PiToolCallContent =>
                isRecord(part) &&
                part.type === "toolCall" &&
                typeof part.id === "string" &&
                typeof part.name === "string" &&
                isRecord(part.arguments),
            )
            .map((part) => ({ id: part.id, name: part.name, input: part.arguments }))
        : [];
    const message: HostMessage = {
      role: raw.role,
      content: textFromPiContent(raw.content),
    };
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
    out.push(message);
  }
  return out;
}

export function memScribeMessagesFromPi(messages: unknown): MemFlywheelMessage[] {
  const hostMessages = hostMessagesFromPi(messages);
  const outputs = new Map<string, string | null | undefined>();
  for (const message of hostMessages) {
    if (message.role === "tool" && message.toolCallId) {
      outputs.set(message.toolCallId, message.content);
    }
  }

  const out: MemFlywheelMessage[] = [];
  for (const message of hostMessages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content.trim() : "";
    const toolCalls =
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => ({
            name: call.name,
            input: call.input,
            output: outputs.get(call.id),
          }))
        : [];
    if (!text && toolCalls.length === 0) continue;
    out.push(
      toolCalls.length > 0 ? { role: message.role, text, toolCalls } : { role: message.role, text },
    );
  }
  return out;
}

export function buildPiPromptInjection(result: HostPromptBuildResult): string {
  const sections: string[] = [];
  if (result.systemPrompt?.trim()) {
    sections.push(`# MemFlywheel rules\n${result.systemPrompt.trim()}`);
  }
  if (result.preludePrompt?.trim()) {
    sections.push(`# MemFlywheel memory index\n${result.preludePrompt.trim()}`);
  }
  if (result.skillPreludePrompt?.trim()) {
    sections.push(`# MemFlywheel learned skills\n${result.skillPreludePrompt.trim()}`);
  }
  return sections.join("\n\n").trim();
}

function piContextResultFromPromptBuild(
  result: HostPromptBuildResult,
  event: unknown,
): { messages: PiAgentMessage[] } | undefined {
  const injection = buildPiPromptInjection(result);
  if (!injection) return undefined;
  const original = isRecord(event) && Array.isArray(event.messages) ? event.messages : [];
  return { messages: [piUserMessage(injection), ...(original as PiAgentMessage[])] };
}

function bindPiEvent(pi: PiExtensionApiLike, event: string, handler: PiExtensionHandler): Dispose {
  const dispose = pi.on(event, handler);
  if (typeof dispose === "function") return dispose;
  if (typeof pi.off === "function") {
    const off = pi.off;
    return () => off(event, handler);
  }
  return () => undefined;
}

export function createPiAgentModelResolver(
  options: CreatePiAgentModelResolverOptions,
): ResolvePiAgentModel {
  return async (): Promise<PiAgentModelBinding> => {
    const ctx = options.getContext?.();
    const model = options.model ?? ctx?.model;
    if (!model) {
      throw new Error("Pi memory agent requires a current Pi model");
    }

    const auth = await ctx?.modelRegistry?.getApiKeyAndHeaders?.(model);
    if (auth && !auth.ok) {
      throw new Error(`Pi model auth unavailable: ${auth.error ?? "unknown error"}`);
    }

    const thinkingLevel = ctx?.getThinkingLevel?.();
    const sessionId = options.getSessionId?.();
    const api = isRecord(model) ? readString(model, "api") : undefined;
    const shortLivedMode = ctx?.mode === "print" || ctx?.mode === "json";
    return {
      model: model as Model<Api>,
      streamFn: options.streamSimple,
      ...(auth?.apiKey ? { getApiKey: () => auth.apiKey } : {}),
      ...(auth?.headers ? { request: { headers: auth.headers } } : {}),
      ...(typeof thinkingLevel === "string"
        ? { thinkingLevel: thinkingLevel as PiAgentModelBinding["thinkingLevel"] }
        : {}),
      ...(shortLivedMode && api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  };
}

export function attachPiScribe(
  scribe: PiScribeLike,
  pi: PiExtensionApiLike,
  options: { sessionId?: PiSessionIdResolver } = {},
): Dispose {
  const disposers: Dispose[] = [];
  const detach = (promise: Promise<unknown>): void => {
    promise.catch(() => undefined);
  };
  const on = (event: string, handler: PiExtensionHandler): void => {
    disposers.push(bindPiEvent(pi, event, handler));
  };

  on("session_start", (event, ctx) => {
    detach(scribe.onSessionStart({ sessionId: resolvePiSessionId(options.sessionId, event, ctx) }));
  });
  on("context", async (event, ctx) => {
    const result = await scribe.onPromptBuild({
      sessionId: resolvePiSessionId(options.sessionId, event, ctx),
      query: promptQueryFromPiEvent(event),
    });
    return piContextResultFromPromptBuild(result, event);
  });
  on("agent_end", (event, ctx) => {
    detach(
      scribe.onTurnEnd({
        sessionId: resolvePiSessionId(options.sessionId, event, ctx),
        messages: memScribeMessagesFromPi(isRecord(event) ? event.messages : undefined),
      }),
    );
  });
  on("session_shutdown", (event, ctx) => {
    detach(scribe.onSessionEnd({ sessionId: resolvePiSessionId(options.sessionId, event, ctx) }));
  });

  return () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };
}

export function createPiHarnessPort(
  pi: PiExtensionApiLike,
  options: CreatePiHarnessPortOptions = {},
): HostHarnessPort {
  let lastContext: PiExtensionContextLike | undefined;
  let lastSessionId: string | undefined;
  const rememberContext = (event?: unknown, ctx?: PiExtensionContextLike): void => {
    if (ctx) lastContext = ctx;
    lastSessionId = resolvePiSessionId(options.sessionId, event, ctx ?? lastContext);
  };

  const resolveModel =
    options.resolveModel ??
    (options.streamSimple
      ? createPiAgentModelResolver({
          streamSimple: options.streamSimple,
          model: options.piModel,
          getContext: () => lastContext,
          getSessionId: () => isolatedBackgroundModelSessionId(lastSessionId),
        })
      : undefined);
  if (!resolveModel) {
    throw new Error("createPiHarnessPort requires either resolveModel or Pi streamSimple");
  }

  const capabilities: HostCapability[] = [
    "prompt-build",
    "turn-end",
    "session-end",
    "agentic-tool-loop",
    "tool-trajectory",
  ];
  if (options.idleIntervalMs) capabilities.push("idle");

  const lifecycle: HostHarnessPort["lifecycle"] = {
    onPromptBuild(handler) {
      return bindPiEvent(pi, "context", async (event, ctx) => {
        rememberContext(event, ctx);
        const result = await handler({
          sessionId: lastSessionId,
          query: promptQueryFromPiEvent(event),
        });
        const contextResult = piContextResultFromPromptBuild(result, event);
        await options.afterPromptBuild?.();
        return contextResult;
      });
    },
    onTurnEnd(handler) {
      return bindPiEvent(pi, "agent_end", async (event, ctx) => {
        rememberContext(event, ctx);
        await handler({
          sessionId: lastSessionId ?? "pi",
          messages: hostMessagesFromPi(isRecord(event) ? event.messages : undefined),
        });
        await options.afterTurnEnd?.();
      });
    },
    onSessionEnd(handler) {
      return bindPiEvent(pi, "session_shutdown", async (event, ctx) => {
        rememberContext(event, ctx);
        await handler({ sessionId: lastSessionId ?? "pi" });
        await options.afterSessionEnd?.();
      });
    },
  };

  if (options.idleIntervalMs) {
    lifecycle.onIdle = (handler) => {
      const timer = setInterval(() => {
        if (lastContext?.isIdle?.()) {
          void handler({ force: false });
        }
      }, options.idleIntervalMs);
      return () => clearInterval(timer);
    };
  }

  return {
    name: "pi",
    capabilities: createCapabilitySet(capabilities),
    resolveModel,
    lifecycle,
    telemetry: {
      onToolCall(handler) {
        return bindPiEvent(pi, "tool_call", async (event, ctx) => {
          rememberContext(event, ctx);
          await handler({
            sessionId: lastSessionId,
            toolCallId: readString(event, "toolCallId") ?? "",
            toolName: readString(event, "toolName") ?? "",
            input: isRecord(event) ? event.input : undefined,
          });
        });
      },
      onToolResult(handler) {
        return bindPiEvent(pi, "tool_result", async (event, ctx) => {
          rememberContext(event, ctx);
          const content = isRecord(event) ? textFromPiContent(event.content) : undefined;
          await handler({
            sessionId: lastSessionId,
            toolCallId: readString(event, "toolCallId") ?? "",
            toolName: readString(event, "toolName") ?? "",
            input: isRecord(event) ? event.input : undefined,
            output: content ?? (isRecord(event) ? event.details : undefined),
            isError: isRecord(event) ? event.isError === true : undefined,
          });
        });
      },
    },
  };
}
