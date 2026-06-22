import type {
  CanonicalModelCompletion,
  CanonicalModelMessage,
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalToolDefinition,
} from "@memscribe/model";

import {
  createCapabilitySet,
  type Dispose,
  type HostHarnessPort,
} from "./harness-port.js";

type PiDispose = Dispose | void;

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<PiTextContent | { type: string; [key: string]: unknown }>;
  isError?: boolean;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: Array<PiTextContent | PiToolCallContent | { type: string; [key: string]: unknown }>;
  stopReason?: string;
}

export interface PiCompletionInput {
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface PiHarnessLike {
  on(event: string, handler: (payload: unknown) => unknown | Promise<unknown>): PiDispose;
  completeSimple(input: PiCompletionInput): Promise<PiAssistantMessage>;
}

function textFromPiContent(content: PiAssistantMessage["content"]): string | null {
  const parts = content
    .filter((part): part is PiTextContent => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  return parts.length > 0 ? parts.join("") : null;
}

function piMessageFromCanonical(message: CanonicalModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolCalls?.[0]?.name ?? "",
      content: message.content ? [{ type: "text", text: message.content }] : [],
      isError: false,
    };
  }
  const content: Array<Record<string, unknown>> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.input,
    });
  }
  return { role: message.role, content };
}

function piToolFromCanonical(tool: CanonicalToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function canonicalResponseFromPi(message: PiAssistantMessage): CanonicalModelResponse {
  const toolCalls = message.content
    .filter(
      (part): part is PiToolCallContent =>
        part.type === "toolCall" &&
        typeof part.id === "string" &&
        typeof part.name === "string" &&
        part.arguments !== null &&
        typeof part.arguments === "object" &&
        !Array.isArray(part.arguments),
    )
    .map((part) => ({
      id: part.id,
      name: part.name,
      input: part.arguments,
    }));
  const out: CanonicalModelMessage = {
    role: "assistant",
    content: textFromPiContent(message.content),
  };
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  return { message: out, finishReason: message.stopReason };
}

export function createPiModelCompletion(pi: PiHarnessLike): CanonicalModelCompletion {
  return {
    async complete(req: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      const response = await pi.completeSimple({
        messages: req.messages.map(piMessageFromCanonical),
        tools: req.tools.map(piToolFromCanonical),
        signal: req.signal,
      });
      return canonicalResponseFromPi(response);
    },
  };
}

function bindPiEvent(
  pi: PiHarnessLike,
  event: string,
  handler: (payload: unknown) => unknown | Promise<unknown>,
): Dispose {
  const dispose = pi.on(event, handler);
  return typeof dispose === "function" ? dispose : () => undefined;
}

export function createPiHarnessPort(pi: PiHarnessLike): HostHarnessPort {
  return {
    name: "pi",
    capabilities: createCapabilitySet([
      "prompt-build",
      "turn-end",
      "session-end",
      "idle",
      "single-tool-completion",
      "agentic-tool-loop",
      "tool-trajectory",
    ]),
    model: createPiModelCompletion(pi),
    lifecycle: {
      onPromptBuild(handler) {
        return bindPiEvent(pi, "turn:build", handler as (payload: unknown) => Promise<unknown>);
      },
      onTurnEnd(handler) {
        return bindPiEvent(pi, "agent_end", handler as (payload: unknown) => Promise<unknown>);
      },
      onSessionEnd(handler) {
        return bindPiEvent(pi, "session_end", handler as (payload: unknown) => Promise<unknown>);
      },
      onIdle(handler) {
        return bindPiEvent(pi, "learning:idle", handler as (payload: unknown) => Promise<unknown>);
      },
    },
    telemetry: {
      onToolCall(handler) {
        return bindPiEvent(pi, "tool_call", handler as (payload: unknown) => Promise<unknown>);
      },
      onToolResult(handler) {
        return bindPiEvent(pi, "tool_result", handler as (payload: unknown) => Promise<unknown>);
      },
    },
  };
}
