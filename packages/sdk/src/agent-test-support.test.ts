import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

import type { ResolvePiAgentModel } from "./agent-runner.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://test.invalid",
  reasoning: false,
  input: ["text"],
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

export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

export function toolTurn(name: string, args: Record<string, unknown>, id = "c1"): ScriptedTurn {
  return { toolCalls: [{ id, name, arguments: args }] };
}

export const stopTurn: ScriptedTurn = { text: "done" };

export function scriptedBinding(
  turns: ScriptedTurn[],
  options: { apiKey?: string } = {},
): {
  resolveModel: ResolvePiAgentModel;
  contexts: () => Context[];
  requestApiKeys: () => (string | undefined)[];
} {
  const seen: Context[] = [];
  const seenApiKeys: (string | undefined)[] = [];
  let index = 0;
  return {
    contexts: () => seen,
    requestApiKeys: () => seenApiKeys,
    resolveModel: () => ({
      model,
      ...(options.apiKey ? { getApiKey: () => options.apiKey } : {}),
      streamFn: (_model, context, streamOptions) => {
        seenApiKeys.push(streamOptions?.apiKey);
        seen.push({
          systemPrompt: context.systemPrompt,
          messages: structuredClone(context.messages),
          tools: context.tools ? [...context.tools] : undefined,
        });
        const turn = turns[index++];
        if (!turn) throw new Error("unexpected test model call");
        const content: AssistantMessage["content"] = [];
        if (turn.text) content.push({ type: "text", text: turn.text });
        for (const call of turn.toolCalls ?? []) {
          content.push({ type: "toolCall", ...call });
        }
        const message: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: turn.toolCalls?.length ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: turn.toolCalls?.length ? "toolUse" : "stop",
          message,
        });
        return stream;
      },
    }),
  };
}
