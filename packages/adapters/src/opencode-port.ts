import { join } from "node:path";

import type {
  CanonicalModelCompletion,
  CanonicalModelMessage,
  CanonicalToolCall,
} from "@memflywheel/model";

import { createMemFlywheelHarnessRuntime } from "./host-memflywheel.js";
import {
  createCapabilitySet,
  type HostHarnessPort,
  type HostToolCallEvent,
  type HostToolResultEvent,
} from "./harness-port.js";
import {
  createOpenAICompatibleEnvModel,
  type OpenAICompatibleEnvModelOptions,
} from "./openai-env-model.js";

type RawRecord = Record<string, unknown>;

export interface OpenCodeClientLike {
  readonly session?: {
    readonly messages?: (options: unknown) => Promise<unknown>;
  };
}

export interface OpenCodePluginInput {
  readonly client?: OpenCodeClientLike;
}

export interface OpenCodeHarnessPortOptions {
  readonly root?: string;
  readonly model?: CanonicalModelCompletion;
  readonly modelEnv?: OpenAICompatibleEnvModelOptions;
  readonly messageLimit?: number;
}

export interface OpenCodeHooks {
  readonly dispose?: () => Promise<void> | void;
  readonly event: (input: { readonly event: unknown }) => Promise<void>;
  readonly "chat.message": (
    input: { readonly sessionID: string },
    output: unknown,
  ) => Promise<void>;
  readonly "experimental.chat.system.transform": (
    input: { readonly sessionID?: string },
    output: { system: string[] },
  ) => Promise<void>;
  readonly "experimental.text.complete": (
    input: { readonly sessionID: string; readonly messageID: string; readonly partID: string },
    output: { readonly text: string },
  ) => Promise<void>;
  readonly "tool.execute.before": (
    input: { readonly tool: string; readonly sessionID: string; readonly callID: string },
    output: { readonly args: unknown },
  ) => Promise<void>;
  readonly "tool.execute.after": (
    input: {
      readonly tool: string;
      readonly sessionID: string;
      readonly callID: string;
      readonly args: unknown;
    },
    output: { readonly output?: string; readonly title?: string; readonly metadata?: unknown },
  ) => Promise<void>;
}

export function defaultOpenCodeMemFlywheelRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMFLYWHEEL_HOME?.trim()) return env.MEMFLYWHEEL_HOME.trim();
  const home = env.HOME?.trim();
  if (!home) throw new Error("OpenCode MemFlywheel root requires HOME or MEMFLYWHEEL_HOME");
  const configRoot =
    env.OPENCODE_CONFIG_DIR?.trim() ||
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  return join(configRoot, "memflywheel");
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function readTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
}

function toolOutputFromState(state: RawRecord): string | undefined {
  if (state.status === "completed" && typeof state.output === "string") return state.output;
  if (state.status === "error" && typeof state.error === "string") return state.error;
  return undefined;
}

export function canonicalMessagesFromOpenCodeSessionMessages(
  raw: unknown,
): CanonicalModelMessage[] {
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.data)
      ? raw.data
      : [];
  const messages: CanonicalModelMessage[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue;
    const role = entry.info.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = readTextFromParts(entry.parts);
    if (role === "user") {
      if (content) messages.push({ role: "user", content });
      continue;
    }

    const toolCalls: CanonicalToolCall[] = [];
    if (Array.isArray(entry.parts)) {
      for (const part of entry.parts) {
        if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) continue;
        const id = readString(part, "callID");
        const name = readString(part, "tool");
        if (id && name) toolCalls.push({ id, name, input: part.state.input });
      }
    }
    if (content || toolCalls.length > 0) {
      messages.push({ role: "assistant", content: content || null, toolCalls });
    }

    if (!Array.isArray(entry.parts)) continue;
    for (const part of entry.parts) {
      if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) continue;
      const callID = readString(part, "callID");
      const output = toolOutputFromState(part.state);
      if (callID && output !== undefined) {
        messages.push({ role: "tool", toolCallId: callID, content: output });
      }
    }
  }
  return messages;
}

function extractSessionId(event: unknown): string | undefined {
  return (
    readString(event, "sessionID") ??
    (isRecord(event) ? readString(event.properties, "sessionID") : undefined) ??
    (isRecord(event) && isRecord(event.properties) && isRecord(event.properties.info)
      ? readString(event.properties.info, "sessionID")
      : undefined)
  );
}

async function readOpenCodeMessages(
  client: OpenCodeClientLike,
  sessionId: string,
  messageLimit: number,
): Promise<CanonicalModelMessage[]> {
  const response = await client.session?.messages?.({
    path: { id: sessionId },
    query: { limit: messageLimit },
  });
  if (!response) throw new Error("OpenCode client.session.messages returned no response");
  return canonicalMessagesFromOpenCodeSessionMessages(response);
}

function appendPromptBuildResult(
  output: { system: string[] },
  result: {
    readonly systemPrompt?: string;
    readonly preludePrompt?: string;
    readonly skillPreludePrompt?: string;
  },
): void {
  for (const section of [result.systemPrompt, result.preludePrompt, result.skillPreludePrompt]) {
    if (section?.trim()) output.system.push(section.trim());
  }
}

function latestUserQuery(messages: readonly CanonicalModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content?.trim()) return message.content.trim();
  }
  return undefined;
}

function withCompletedAssistantText(
  messages: readonly CanonicalModelMessage[],
  text: string,
): CanonicalModelMessage[] {
  const completedText = text.trim();
  if (!completedText) return [...messages];
  if (messages.some((message) => message.role === "assistant" && message.content?.trim())) {
    return [...messages];
  }
  return [...messages, { role: "assistant", content: completedText }];
}

export function createOpenCodeHarnessPort(
  client: OpenCodeClientLike,
  options: OpenCodeHarnessPortOptions = {},
): HostHarnessPort & { readonly hooks: OpenCodeHooks } {
  const model = options.model ?? createOpenAICompatibleEnvModel(options.modelEnv);
  const messageLimit = options.messageLimit ?? 200;
  let lastSessionId: string | undefined;
  const completedTextParts = new Set<string>();
  const promptHandlers = new Set<Parameters<HostHarnessPort["lifecycle"]["onPromptBuild"]>[0]>();
  const turnHandlers = new Set<Parameters<HostHarnessPort["lifecycle"]["onTurnEnd"]>[0]>();
  const sessionEndHandlers = new Set<Parameters<HostHarnessPort["lifecycle"]["onSessionEnd"]>[0]>();
  const toolCallHandlers = new Set<(event: HostToolCallEvent) => Promise<void>>();
  const toolResultHandlers = new Set<(event: HostToolResultEvent) => Promise<void>>();

  const hooks: OpenCodeHooks = {
    async event({ event }) {
      const type = readString(event, "type");
      const sessionId = extractSessionId(event);
      if (sessionId) lastSessionId = sessionId;
      if (type === "session.idle" && sessionId) {
        const messages = await readOpenCodeMessages(client, sessionId, messageLimit);
        for (const handler of turnHandlers) await handler({ sessionId, messages });
      }
      if (type === "session.deleted" && sessionId) {
        for (const handler of sessionEndHandlers) await handler({ sessionId });
      }
    },
    async "chat.message"(input) {
      lastSessionId = input.sessionID;
    },
    async "experimental.chat.system.transform"(input, output) {
      const sessionId = input.sessionID ?? lastSessionId;
      const query = sessionId
        ? latestUserQuery(await readOpenCodeMessages(client, sessionId, messageLimit))
        : undefined;
      for (const handler of promptHandlers) {
        const result = await handler({ sessionId, query });
        appendPromptBuildResult(output, result);
      }
    },
    async "experimental.text.complete"(input, output) {
      const key = `${input.sessionID}:${input.messageID}:${input.partID}`;
      if (completedTextParts.has(key)) return;
      completedTextParts.add(key);
      lastSessionId = input.sessionID;
      const messages = withCompletedAssistantText(
        await readOpenCodeMessages(client, input.sessionID, messageLimit),
        output.text,
      );
      for (const handler of turnHandlers) await handler({ sessionId: input.sessionID, messages });
    },
    async "tool.execute.before"(input, output) {
      for (const handler of toolCallHandlers) {
        await handler({
          sessionId: input.sessionID,
          toolCallId: input.callID,
          toolName: input.tool,
          input: output.args,
        });
      }
    },
    async "tool.execute.after"(input, output) {
      for (const handler of toolResultHandlers) {
        await handler({
          sessionId: input.sessionID,
          toolCallId: input.callID,
          toolName: input.tool,
          input: input.args,
          output: output.output,
        });
      }
    },
  };

  return {
    name: "opencode",
    capabilities: createCapabilitySet([
      "prompt-build",
      "turn-end",
      "session-end",
      "single-tool-completion",
      "agentic-tool-loop",
      "tool-trajectory",
    ]),
    model,
    hooks,
    lifecycle: {
      onPromptBuild(handler) {
        promptHandlers.add(handler);
        return () => promptHandlers.delete(handler);
      },
      onTurnEnd(handler) {
        turnHandlers.add(handler);
        return () => turnHandlers.delete(handler);
      },
      onSessionEnd(handler) {
        sessionEndHandlers.add(handler);
        return () => sessionEndHandlers.delete(handler);
      },
    },
    telemetry: {
      onToolCall(handler) {
        toolCallHandlers.add(handler);
        return () => toolCallHandlers.delete(handler);
      },
      onToolResult(handler) {
        toolResultHandlers.add(handler);
        return () => toolResultHandlers.delete(handler);
      },
    },
  };
}

export function createOpenCodePluginServer(
  input: OpenCodePluginInput,
  options: OpenCodeHarnessPortOptions = {},
): OpenCodeHooks {
  if (!input.client) throw new Error("MemFlywheel OpenCode plugin requires input.client");
  const root = options.root ?? defaultOpenCodeMemFlywheelRoot();
  const port = createOpenCodeHarnessPort(input.client, options);
  const runtime = createMemFlywheelHarnessRuntime({
    port,
    root,
    learnedSkills: { skillsRoot: join(root, "learned-skills") },
  });
  return {
    ...port.hooks,
    dispose: runtime.dispose,
  };
}
