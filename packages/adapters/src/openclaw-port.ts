import { join } from "node:path";

import type { CanonicalModelCompletion, CanonicalModelMessage } from "@memflywheel/model";

import { createMemFlywheelHarnessRuntime } from "./host-memflywheel.js";
import { createCapabilitySet, type Dispose, type HostHarnessPort } from "./harness-port.js";
import {
  createOpenAICompatibleEnvModel,
  type OpenAICompatibleEnvModelOptions,
} from "./openai-env-model.js";

type RawRecord = Record<string, unknown>;
type OpenClawHookHandler = (event: unknown, context?: unknown) => Promise<unknown> | unknown;

export interface OpenClawApiLike {
  readonly on?: (event: string, handler: OpenClawHookHandler, opts?: unknown) => void;
  readonly registerHook?: (
    events: string | readonly string[],
    handler: OpenClawHookHandler,
    opts?: unknown,
  ) => void;
  readonly registerMemoryCapability?: (capability: unknown) => void;
}

export interface OpenClawHarnessPortOptions {
  readonly root?: string;
  readonly model?: CanonicalModelCompletion;
  readonly modelEnv?: OpenAICompatibleEnvModelOptions;
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function textFromContent(content: unknown, topText: unknown): string {
  if (typeof topText === "string" && topText.trim()) return topText.trim();
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
}

function parseToolInput(argumentsJson: unknown, callId: string): unknown {
  if (argumentsJson === undefined || argumentsJson === null || argumentsJson === "") return {};
  if (typeof argumentsJson !== "string") return argumentsJson;
  try {
    return JSON.parse(argumentsJson);
  } catch (error) {
    throw new Error(`OpenClaw transcript tool call ${callId} has invalid JSON arguments.`, {
      cause: error,
    });
  }
}

function canonicalToolCalls(message: RawRecord): NonNullable<CanonicalModelMessage["toolCalls"]> {
  const calls: NonNullable<CanonicalModelMessage["toolCalls"]> = [];
  if (Array.isArray(message.toolCalls)) {
    for (const raw of message.toolCalls) {
      if (!isRecord(raw)) continue;
      const id = readString(raw, "id");
      const name = readString(raw, "name");
      if (id && name) calls.push({ id, name, input: raw.input });
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw)) continue;
      const id = readString(raw, "id");
      const fn = isRecord(raw.function) ? raw.function : undefined;
      const name = fn ? readString(fn, "name") : readString(raw, "name");
      if (id && name)
        calls.push({ id, name, input: parseToolInput(fn?.arguments ?? raw.input, id) });
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part) || (part.type !== "tool_use" && part.type !== "toolCall")) continue;
      const id = readString(part, "id");
      const name = readString(part, "name");
      const input = part.type === "toolCall" ? part.arguments : part.input;
      if (id && name) calls.push({ id, name, input });
    }
  }
  return calls;
}

export function canonicalMessagesFromOpenClawMessages(raw: unknown): CanonicalModelMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: CanonicalModelMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const role = item.role;
    if (role === "tool" || role === "toolResult") {
      const toolCallId = readString(item, "toolCallId") ?? readString(item, "tool_call_id");
      if (toolCallId)
        messages.push({
          role: "tool",
          toolCallId,
          content: textFromContent(item.content, item.text),
        });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const content = textFromContent(item.content, item.text);
    const toolCalls = role === "assistant" ? canonicalToolCalls(item) : [];
    if (!content && toolCalls.length === 0) continue;
    messages.push(
      toolCalls.length > 0 ? { role, content: content || null, toolCalls } : { role, content },
    );
  }
  return messages;
}

function openClawSessionId(event: unknown, context: unknown): string {
  return (
    readString(context, "sessionKey") ??
    readString(context, "sessionId") ??
    readString(event, "sessionKey") ??
    readString(event, "sessionId") ??
    readString(event, "sessionID") ??
    readString(context, "runId") ??
    readString(event, "runId") ??
    "openclaw"
  );
}

function messagesFromAgentEnd(event: unknown): CanonicalModelMessage[] {
  if (!isRecord(event)) return [];
  return canonicalMessagesFromOpenClawMessages(event.messages ?? event.history);
}

function joinSections(sections: readonly (string | undefined)[]): string | undefined {
  const text = sections
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n");
  return text || undefined;
}

function registerOpenClawHook(
  api: OpenClawApiLike,
  events: string | readonly string[],
  handler: OpenClawHookHandler,
  legacyName: string,
): void {
  const names = Array.isArray(events) ? events : [events];
  if (api.on) {
    for (const name of names) api.on(name, handler);
    return;
  }
  if (api.registerHook) {
    api.registerHook(events, handler, { name: legacyName });
    return;
  }
  throw new Error("OpenClaw plugin API does not expose hook registration.");
}

export function defaultOpenClawMemFlywheelRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMFLYWHEEL_HOME?.trim()) return env.MEMFLYWHEEL_HOME.trim();
  const home = env.HOME?.trim();
  if (!home) throw new Error("OpenClaw MemFlywheel root requires HOME or MEMFLYWHEEL_HOME");
  return join(home, ".openclaw", "memflywheel");
}

export function createOpenClawHarnessPort(
  api: OpenClawApiLike,
  options: OpenClawHarnessPortOptions = {},
): HostHarnessPort {
  const model = options.model ?? createOpenAICompatibleEnvModel(options.modelEnv);
  let backgroundQueue: Promise<void> = Promise.resolve();

  function enqueueBackground(task: () => Promise<void>): void {
    const run = backgroundQueue.then(task, task);
    backgroundQueue = run.then(
      () => undefined,
      () => undefined,
    );
    void run.catch((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });
  }

  return {
    name: "openclaw",
    capabilities: createCapabilitySet([
      "prompt-build",
      "turn-end",
      "session-end",
      "single-tool-completion",
      "agentic-tool-loop",
      "tool-trajectory",
    ]),
    model,
    lifecycle: {
      onPromptBuild(handler) {
        registerOpenClawHook(
          api,
          "before_prompt_build",
          async (event, context) => {
            const result = await handler({
              sessionId: openClawSessionId(event, context),
              query: readString(event, "prompt"),
            });
            return {
              prependSystemContext: joinSections([result.systemPrompt]),
              prependContext: joinSections([result.preludePrompt, result.skillPreludePrompt]),
            };
          },
          "memflywheel-before-prompt-build",
        );
        return () => undefined;
      },
      onTurnEnd(handler) {
        registerOpenClawHook(
          api,
          "agent_end",
          (event, context) => {
            enqueueBackground(() =>
              handler({
                sessionId: openClawSessionId(event, context),
                messages: messagesFromAgentEnd(event),
              }).then(() => undefined),
            );
          },
          "memflywheel-agent-end",
        );
        return () => undefined;
      },
      onSessionEnd(handler) {
        registerOpenClawHook(
          api,
          ["session_end", "gateway_stop"],
          async (event, context) => {
            await handler({ sessionId: openClawSessionId(event, context) });
          },
          "memflywheel-session-end",
        );
        return () => undefined;
      },
    },
  };
}

export function registerOpenClawMemoryCapability(api: OpenClawApiLike): void {
  api.registerMemoryCapability?.({
    promptBuilder: () => ["MemFlywheel long-term memory is active."],
  });
}

export function createOpenClawPluginRuntime(
  api: OpenClawApiLike,
  options: OpenClawHarnessPortOptions = {},
): Dispose {
  registerOpenClawMemoryCapability(api);
  const root = options.root ?? defaultOpenClawMemFlywheelRoot();
  const port = createOpenClawHarnessPort(api, options);
  const runtime = createMemFlywheelHarnessRuntime({
    port,
    root,
    learnedSkills: { skillsRoot: join(root, "learned-skills") },
  });
  return runtime.dispose;
}
