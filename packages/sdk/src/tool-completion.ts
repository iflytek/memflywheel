/**
 * Tool-calling completion (zero runtime deps; Node global fetch).
 *
 * The OpenAI-compatible /chat/completions transport with a `tools` array. One
 * round-trip: messages + tools in, the assistant message (content and/or
 * tool_calls) out. The extraction agent loop feeds tool results back as
 * role:"tool" messages and calls this again, until the model stops requesting
 * tools. This module performs network I/O — it is the SDK's job, never core's.
 *
 * Provider/endpoint/key/model resolve from explicit config then env (the
 * MEMSCRIBE_LLM_* variables, shared with completion.ts). The key is resolved
 * lazily at call time, so constructing a tool-completion never requires a key.
 */

/** A JSON-schema object (re-declared locally so the SDK has no value import need). */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** Roles in a tool-calling conversation. */
export type ToolRole = "system" | "user" | "assistant" | "tool";

/** One assistant request to call a function tool. */
export interface ToolCall {
  id: string;
  type: "function";
  /** `arguments` is a JSON string (parsed defensively by the caller). */
  function: { name: string; arguments: string };
}

/** A single conversation message in the OpenAI tool-calling shape. */
export interface ToolMessage {
  role: ToolRole;
  content?: string | null;
  /** Present on an assistant turn that requested tools. */
  tool_calls?: ToolCall[];
  /** Present on a role:"tool" reply; correlates to a prior call id. */
  tool_call_id?: string;
}

/** A tool advertised to the model. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
    strict?: boolean;
  };
}

/** One model round-trip request. */
export interface ToolCompletionRequest {
  messages: ToolMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

/** One model round-trip response. */
export interface ToolCompletionResponse {
  /** The assistant message verbatim (content and/or tool_calls). */
  message: ToolMessage;
  /** "tool_calls" | "stop" | … (provider finish_reason). */
  finishReason?: string;
}

/** The tool-calling completion callable: messages + tools in, assistant out. */
export type ToolCompletion = (req: ToolCompletionRequest) => Promise<ToolCompletionResponse>;

/** Configuration for {@link createToolCompletion}. All fields fall back to env. */
export interface ToolCompletionConfig {
  /** Base URL (no trailing /chat/completions). */
  endpoint?: string;
  /** API key. Falls back to MEMSCRIBE_LLM_API_KEY / OPENAI_API_KEY. */
  apiKey?: string;
  /** Model id. */
  model?: string;
  /** Output token cap. */
  maxTokens?: number;
  /** Sampling temperature (default 0 for deterministic judgment). */
  temperature?: number;
  /** Injectable fetch (for tests). Defaults to the Node global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 1024;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function resolveApiKey(config: ToolCompletionConfig): string {
  const key = config.apiKey ?? env("MEMSCRIBE_LLM_API_KEY") ?? env("OPENAI_API_KEY");
  if (!key) {
    throw new Error(
      "MemScribe tool completion: no API key. Set MEMSCRIBE_LLM_API_KEY (or OPENAI_API_KEY).",
    );
  }
  return key;
}

function resolveEndpoint(config: ToolCompletionConfig): string {
  const base = config.endpoint ?? env("MEMSCRIBE_LLM_ENDPOINT") ?? DEFAULT_ENDPOINT;
  return base.replace(/\/+$/, "");
}

function resolveModel(config: ToolCompletionConfig): string {
  return config.model ?? env("MEMSCRIBE_LLM_MODEL") ?? DEFAULT_MODEL;
}

function resolveMaxTokens(config: ToolCompletionConfig): number {
  if (typeof config.maxTokens === "number") return config.maxTokens;
  const fromEnv = env("MEMSCRIBE_LLM_MAX_TOKENS");
  const parsed = fromEnv ? Number.parseInt(fromEnv, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

/** Serialize a ToolMessage into the OpenAI wire shape (drop undefined fields). */
function toWireMessage(message: ToolMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role };
  // OpenAI requires `content` to be present (may be null for a tool_calls turn).
  wire.content = message.content ?? null;
  if (message.tool_calls && message.tool_calls.length > 0) {
    wire.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
  return wire;
}

/** Parse the assistant message out of an OpenAI /chat/completions response. */
function parseResponse(json: unknown): ToolCompletionResponse {
  const choice = (json as { choices?: Array<{ message?: unknown; finish_reason?: unknown }> })
    ?.choices?.[0];
  const rawMessage = (choice?.message ?? {}) as {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
  };
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(rawMessage.tool_calls)) {
    for (const entry of rawMessage.tool_calls) {
      const call = entry as {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const name = call.function?.name;
      if (typeof name !== "string") continue;
      toolCalls.push({
        id: typeof call.id === "string" ? call.id : `call_${toolCalls.length}`,
        type: "function",
        function: {
          name,
          arguments:
            typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
        },
      });
    }
  }

  const message: ToolMessage = {
    role: "assistant",
    content: typeof rawMessage.content === "string" ? rawMessage.content : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { message, finishReason };
}

/**
 * Build a {@link ToolCompletion} backed by Node's global fetch. OpenAI-compatible
 * /chat/completions with a tools array and tool_choice:"auto". A non-2xx response
 * throws (the agent loop propagates it; the extraction session treats a thrown
 * completion as a safely skipped/failed turn — no cursor advance).
 */
export function createToolCompletion(config: ToolCompletionConfig = {}): ToolCompletion {
  const endpoint = resolveEndpoint(config);
  const model = resolveModel(config);
  const maxTokens = resolveMaxTokens(config);
  const temperature = config.temperature ?? 0;
  const doFetch = config.fetchImpl ?? fetch;

  return async function toolCompletion(req: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    const apiKey = resolveApiKey(config);
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: req.messages.map(toWireMessage),
      tools: req.tools,
      tool_choice: "auto",
    });
    const response = await doFetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: req.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `MemScribe tool completion: request failed (${response.status}). ${detail}`.trim(),
      );
    }
    const json = await response.json();
    return parseResponse(json);
  };
}
