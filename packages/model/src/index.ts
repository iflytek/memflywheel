/**
 * Provider-neutral tool-calling model protocol for MemScribe.
 *
 * This package is the only model contract the SDK consumes. Provider wire shapes
 * such as OpenAI Chat Completions live behind mappers here; the memory, skill,
 * and dream loops never depend on provider-specific fields like `tool_calls` or
 * JSON-string arguments.
 */

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: readonly string[];
  additionalProperties: false;
}

export type CanonicalModelRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface CanonicalModelMessage {
  role: CanonicalModelRole;
  content?: string | null;
  toolCalls?: CanonicalToolCall[];
  toolCallId?: string;
}

export interface CanonicalToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  strict?: boolean;
}

export interface CanonicalModelRequest {
  messages: CanonicalModelMessage[];
  tools: CanonicalToolDefinition[];
  signal?: AbortSignal;
}

export interface CanonicalModelResponse {
  message: CanonicalModelMessage;
  finishReason?: string;
}

export interface CanonicalModelCompletion {
  complete(req: CanonicalModelRequest): Promise<CanonicalModelResponse>;
}

export type CanonicalModelComplete = CanonicalModelCompletion["complete"];

export interface OpenAIChatCompletionsModelConfig {
  /** Base URL without `/chat/completions`. */
  endpoint?: string;
  /** API key. Falls back to MEMSCRIBE_LLM_API_KEY / OPENAI_API_KEY. */
  apiKey?: string;
  /** Model id. */
  model?: string;
  /** Output token cap. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Injectable fetch for tests and host-owned transports. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 1024;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function resolveApiKey(config: OpenAIChatCompletionsModelConfig): string {
  const key = config.apiKey ?? env("MEMSCRIBE_LLM_API_KEY") ?? env("OPENAI_API_KEY");
  if (!key) {
    throw new Error(
      "MemScribe OpenAI chat model: no API key. Set MEMSCRIBE_LLM_API_KEY or OPENAI_API_KEY.",
    );
  }
  return key;
}

function resolveEndpoint(config: OpenAIChatCompletionsModelConfig): string {
  const base = config.endpoint ?? env("MEMSCRIBE_LLM_ENDPOINT") ?? DEFAULT_ENDPOINT;
  return base.replace(/\/+$/, "");
}

function resolveModel(config: OpenAIChatCompletionsModelConfig): string {
  return config.model ?? env("MEMSCRIBE_LLM_MODEL") ?? DEFAULT_MODEL;
}

function resolveMaxTokens(config: OpenAIChatCompletionsModelConfig): number {
  if (typeof config.maxTokens === "number") return config.maxTokens;
  const fromEnv = env("MEMSCRIBE_LLM_MAX_TOKENS");
  const parsed = fromEnv ? Number.parseInt(fromEnv, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

function toWireTool(tool: CanonicalToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  };
}

function stringifyToolInput(input: unknown, toolName: string): string {
  try {
    return JSON.stringify(input ?? {});
  } catch (error) {
    throw new Error(
      `MemScribe OpenAI chat model: canonical tool input for ${toolName} is not JSON-serializable.`,
      { cause: error },
    );
  }
}

function toWireMessage(message: CanonicalModelMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: message.role,
    content: message.content ?? null,
  };
  if (message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: stringifyToolInput(call.input, call.name),
      },
    }));
  }
  if (message.toolCallId) wire.tool_call_id = message.toolCallId;
  return wire;
}

function parseToolInput(raw: unknown, id: string): unknown {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") {
    throw new Error(`MemScribe OpenAI chat model: tool call ${id} arguments must be a JSON string.`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`MemScribe OpenAI chat model: invalid JSON tool arguments for ${id}.`, {
      cause: error,
    });
  }
}

function parseResponse(json: unknown): CanonicalModelResponse {
  const choice = (json as { choices?: Array<{ message?: unknown; finish_reason?: unknown }> })
    ?.choices?.[0];
  if (!choice) {
    throw new Error("MemScribe OpenAI chat model: response has no choices.");
  }
  const rawMessage = (choice.message ?? {}) as {
    content?: unknown;
    tool_calls?: unknown;
  };

  const toolCalls: CanonicalToolCall[] = [];
  if (Array.isArray(rawMessage.tool_calls)) {
    for (const rawCall of rawMessage.tool_calls) {
      const call = rawCall as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (typeof call.id !== "string" || call.id.trim() === "") {
        throw new Error("MemScribe OpenAI chat model: provider tool call missing id.");
      }
      if (typeof call.function?.name !== "string" || call.function.name.trim() === "") {
        throw new Error(`MemScribe OpenAI chat model: tool call ${call.id} missing name.`);
      }
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        input: parseToolInput(call.function.arguments, call.id),
      });
    }
  }

  const message: CanonicalModelMessage = {
    role: "assistant",
    content: typeof rawMessage.content === "string" ? rawMessage.content : null,
  };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return {
    message,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

export function createOpenAIChatCompletionsModel(
  config: OpenAIChatCompletionsModelConfig = {},
): CanonicalModelCompletion {
  const endpoint = resolveEndpoint(config);
  const model = resolveModel(config);
  const maxTokens = resolveMaxTokens(config);
  const temperature = config.temperature ?? 0;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async complete(req: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      const body = JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: req.messages.map(toWireMessage),
        tools: req.tools.map(toWireTool),
        tool_choice: "auto",
      });
      const response = await doFetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resolveApiKey(config)}`,
        },
        body,
        signal: req.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `MemScribe OpenAI chat model: request failed (${response.status}). ${detail}`.trim(),
        );
      }
      return parseResponse(await response.json());
    },
  };
}
