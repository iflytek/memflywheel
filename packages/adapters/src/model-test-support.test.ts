import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ResolvePiAgentModel } from "@memflywheel/sdk";

export interface TestModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolCallId?: string;
}

export interface TestModelResponse {
  message: TestModelMessage;
  finishReason?: string;
}

export interface TestModelCompletion {
  complete(request: {
    messages: TestModelMessage[];
    tools: Array<{ name: string; description: string; inputSchema: object }>;
    signal?: AbortSignal;
  }): Promise<TestModelResponse>;
}

const model = {
  id: "test",
  name: "test",
  api: "openai-completions" as const,
  provider: "test",
  baseUrl: "http://test.invalid",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_384,
  maxTokens: 4_096,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(response: TestModelResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (response.message.content) content.push({ type: "text", text: response.message.content });
  for (const call of response.message.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.input as Record<string, unknown>,
    });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: response.message.toolCalls?.length ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** Transitional test fixture only; production exposes no canonical completion adapter. */
export function resolveTestModel(completion: TestModelCompletion): ResolvePiAgentModel {
  return () => ({
    model,
    streamFn: async (_model, context, options) => {
      const messages: TestModelMessage[] = [];
      if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
      for (const message of context.messages) {
        if (message.role === "user") {
          messages.push({
            role: "user",
            content:
              typeof message.content === "string"
                ? message.content
                : message.content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("\n"),
          });
        } else if (message.role === "assistant") {
          messages.push({
            role: "assistant",
            content: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
            toolCalls: message.content.flatMap((part) =>
              part.type === "toolCall"
                ? [{ id: part.id, name: part.name, input: part.arguments }]
                : [],
            ),
          });
        } else {
          messages.push({
            role: "tool",
            toolCallId: message.toolCallId,
            content: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
          });
        }
      }
      const response = assistant(
        await completion.complete({
          messages,
          tools: (context.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters as never,
          })),
          signal: options?.signal,
        }),
      );
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
        message: response,
      });
      return stream;
    },
  });
}
