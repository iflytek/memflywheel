import { join } from "node:path";

import type { PiAgentModelBinding, ResolvePiAgentModel } from "@memflywheel/sdk";

import { createMemFlywheelHarnessRuntime } from "./host-memflywheel.js";
import {
  createCapabilitySet,
  type HostHarnessPort,
  type HostMessage,
  type HostToolCall,
  type HostToolCallEvent,
  type HostToolResultEvent,
} from "./harness-port.js";
import { createPiAiModelBinding } from "./opencode-pi-model.js";
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
  readonly resolveModel?: ResolvePiAgentModel;
  readonly messageLimit?: number;
}

export interface OpenCodeHooks {
  readonly dispose?: () => Promise<void> | void;
  readonly config: (config: { permission?: unknown }) => Promise<void>;
  readonly event: (input: { readonly event: unknown }) => Promise<void>;
  readonly "chat.message": (
    input: {
      readonly sessionID: string;
      readonly model?: { readonly providerID?: string; readonly modelID?: string };
    },
    output: unknown,
  ) => Promise<void>;
  readonly "chat.params": (
    input: {
      readonly sessionID: string;
      readonly model: unknown;
      readonly provider: unknown;
    },
    output: {
      readonly temperature?: number;
      readonly maxOutputTokens?: number;
      readonly options?: RawRecord;
    },
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

const PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);

function permissionRuleObject(value: unknown): RawRecord {
  if (typeof value === "string" && PERMISSION_ACTIONS.has(value)) return { "*": value };
  return isRecord(value) ? { ...value } : {};
}

/** Allow every OpenCode session to progressively read the active MemFlywheel store. */
export function configureOpenCodeMemoryPermission(
  config: { permission?: unknown },
  root: string,
): void {
  const permission = permissionRuleObject(config.permission);
  const externalDirectory = permissionRuleObject(permission.external_directory);
  externalDirectory[join(root, "*")] = "allow";
  config.permission = {
    ...permission,
    external_directory: externalDirectory,
  };
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function openCodeProviderInfo(provider: unknown): RawRecord {
  if (!isRecord(provider)) throw new Error("OpenCode did not provide model provider context.");
  if (typeof provider.id === "string") return provider;
  if (isRecord(provider.info) && typeof provider.info.id === "string") return provider.info;
  throw new Error("OpenCode model provider context has no provider info.");
}

function openCodeProviderOptions(provider: unknown, output: unknown): RawRecord {
  const info = openCodeProviderInfo(provider);
  const hookOptions = isRecord(output) && isRecord(output.options) ? output.options : {};
  const contextOptions = isRecord(provider) && isRecord(provider.options) ? provider.options : {};
  const infoOptions = isRecord(info.options) ? info.options : {};
  return { ...infoOptions, ...contextOptions, ...hookOptions };
}

export function piApiForOpenCodeTransport(
  apiPackage: string,
  providerId?: string,
):
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "azure-openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream"
  | "mistral-conversations" {
  switch (apiPackage) {
    case "@ai-sdk/openai-compatible":
      return "openai-completions";
    case "@ai-sdk/openai":
      return providerId === "openai-codex" ? "openai-codex-responses" : "openai-responses";
    case "@ai-sdk/azure":
      return "azure-openai-responses";
    case "@ai-sdk/anthropic":
      return "anthropic-messages";
    case "@ai-sdk/google":
      return "google-generative-ai";
    case "@ai-sdk/google-vertex":
      return "google-vertex";
    case "@ai-sdk/amazon-bedrock":
      return "bedrock-converse-stream";
    case "@ai-sdk/mistral":
      return "mistral-conversations";
    default:
      throw new Error(
        `OpenCode transport ${apiPackage} has no exact pi-ai API mapping in MemFlywheel.`,
      );
  }
}

function openCodeProviderEnv(options: RawRecord): Record<string, string> {
  const env: Record<string, string> = {};
  const mappings = {
    accessKeyId: "AWS_ACCESS_KEY_ID",
    secretAccessKey: "AWS_SECRET_ACCESS_KEY",
    sessionToken: "AWS_SESSION_TOKEN",
  } as const;
  for (const [option, name] of Object.entries(mappings)) {
    const value = readString(options, option);
    if (value) env[name] = value;
  }
  return env;
}

function openCodePiRequestOptions(
  api: ReturnType<typeof piApiForOpenCodeTransport>,
  providerOptions: RawRecord,
): RawRecord {
  if (api === "bedrock-converse-stream") {
    return {
      ...(readString(providerOptions, "region")
        ? { region: readString(providerOptions, "region") }
        : {}),
      ...(readString(providerOptions, "profile")
        ? { profile: readString(providerOptions, "profile") }
        : {}),
      ...(readString(providerOptions, "bearerToken")
        ? { bearerToken: readString(providerOptions, "bearerToken") }
        : {}),
    };
  }
  if (api === "google-vertex") {
    return {
      ...(readString(providerOptions, "project")
        ? { project: readString(providerOptions, "project") }
        : {}),
      ...(readString(providerOptions, "location")
        ? { location: readString(providerOptions, "location") }
        : {}),
    };
  }
  if (api === "azure-openai-responses") {
    return {
      ...(readString(providerOptions, "apiVersion")
        ? { azureApiVersion: readString(providerOptions, "apiVersion") }
        : {}),
      ...(readString(providerOptions, "resourceName")
        ? { azureResourceName: readString(providerOptions, "resourceName") }
        : {}),
      ...(readString(providerOptions, "deploymentName")
        ? { azureDeploymentName: readString(providerOptions, "deploymentName") }
        : {}),
    };
  }
  return {};
}

function openCodePiBaseUrl(
  api: ReturnType<typeof piApiForOpenCodeTransport>,
  endpoint: string,
): string {
  if (api === "anthropic-messages") return endpoint.replace(/\/v1\/?$/, "");
  return endpoint;
}

const OPENAI_COMPATIBLE_TRANSPORT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens" as const,
  supportsStrictMode: false,
};

/** Build a pi-ai completion from OpenCode's resolved model and credential context. */
export function createOpenCodeHostModel(
  input: { readonly model: unknown; readonly provider: unknown },
  output: {
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly options?: RawRecord;
  },
): PiAgentModelBinding {
  if (!isRecord(input.model)) throw new Error("OpenCode did not provide the active model.");
  const modelId = readString(input.model, "id") ?? readString(input.model, "modelID");
  const api = isRecord(input.model.api) ? input.model.api : undefined;
  const providerInfo = openCodeProviderInfo(input.provider);
  const providerOptions = openCodeProviderOptions(input.provider, output);
  const apiPackage = api ? readString(api, "npm") : undefined;

  if (!modelId) throw new Error("OpenCode active model has no model id.");
  if (!apiPackage) throw new Error(`OpenCode model ${modelId} has no transport package.`);
  const providerId = readString(providerInfo, "id") ?? "unknown";
  const piApi = piApiForOpenCodeTransport(apiPackage, providerId);

  const endpoint =
    readString(providerOptions, "baseURL") ?? (api ? readString(api, "url") : undefined);
  const apiKey = readString(providerOptions, "apiKey") ?? readString(providerInfo, "key");
  if (!endpoint && piApi !== "bedrock-converse-stream" && piApi !== "google-vertex") {
    throw new Error(`OpenCode model ${modelId} has no resolved endpoint.`);
  }
  const capabilities = isRecord(input.model.capabilities) ? input.model.capabilities : {};
  const inputCapabilities = isRecord(capabilities.input) ? capabilities.input : {};
  const limit = isRecord(input.model.limit) ? input.model.limit : {};
  const modelHeaders = stringRecord(input.model.headers);
  const providerHeaders = stringRecord(providerOptions.headers);
  const maxTokens = output.maxOutputTokens ?? readNumber(limit, "output");
  const contextWindow = readNumber(limit, "context");
  if (!maxTokens || !contextWindow) {
    throw new Error(`OpenCode model ${modelId} has incomplete token limits.`);
  }

  return createPiAiModelBinding({
    api: piApi,
    provider: providerId,
    model: api ? (readString(api, "id") ?? modelId) : modelId,
    name: readString(input.model, "name") ?? modelId,
    baseUrl: openCodePiBaseUrl(piApi, endpoint ?? ""),
    apiKey,
    headers: { ...modelHeaders, ...providerHeaders },
    env: openCodeProviderEnv(providerOptions),
    reasoning: capabilities.reasoning === true,
    input: ["text", ...(inputCapabilities.image === true ? (["image"] as const) : [])],
    contextWindow,
    maxTokens,
    ...(piApi === "openai-completions"
      ? {
          compat: OPENAI_COMPATIBLE_TRANSPORT,
          thinkingLevelMap: { off: null },
        }
      : {}),
    temperature: output.temperature,
    requestOptions: openCodePiRequestOptions(piApi, providerOptions),
  });
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

export function hostMessagesFromOpenCodeSessionMessages(raw: unknown): HostMessage[] {
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.data)
      ? raw.data
      : [];
  const messages: HostMessage[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue;
    const role = entry.info.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = readTextFromParts(entry.parts);
    if (role === "user") {
      if (content) messages.push({ role: "user", content });
      continue;
    }

    const toolCalls: HostToolCall[] = [];
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
): Promise<HostMessage[]> {
  const response = await client.session?.messages?.({
    path: { id: sessionId },
    query: { limit: messageLimit },
  });
  if (!response) throw new Error("OpenCode client.session.messages returned no response");
  return hostMessagesFromOpenCodeSessionMessages(response);
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

function latestUserQuery(messages: readonly HostMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content?.trim()) return message.content.trim();
  }
  return undefined;
}

function withCompletedAssistantText(messages: readonly HostMessage[], text: string): HostMessage[] {
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
  let hostModel: PiAgentModelBinding | undefined;
  const resolveModel: ResolvePiAgentModel =
    options.resolveModel ??
    (() => {
      if (!hostModel) {
        throw new Error(
          "MemFlywheel has not received OpenCode's active model context. " +
            "A host chat.params event must occur before memory extraction.",
        );
      }
      return hostModel;
    });
  const messageLimit = options.messageLimit ?? 200;
  let lastSessionId: string | undefined;
  const pendingCompletedText = new Map<string, { messageId: string; parts: Map<string, string> }>();
  const deliveredTranscripts = new Map<string, string>();
  const turnDispatches = new Map<string, Promise<void>>();
  const promptHandlers = new Set<Parameters<HostHarnessPort["lifecycle"]["onPromptBuild"]>[0]>();
  const turnHandlers = new Set<Parameters<HostHarnessPort["lifecycle"]["onTurnEnd"]>[0]>();
  const sessionEndHandlers = new Set<Parameters<HostHarnessPort["lifecycle"]["onSessionEnd"]>[0]>();
  const toolCallHandlers = new Set<(event: HostToolCallEvent) => Promise<void>>();
  const toolResultHandlers = new Set<(event: HostToolResultEvent) => Promise<void>>();

  const dispatchCompletedTurn = async (sessionId: string): Promise<void> => {
    const previous = turnDispatches.get(sessionId) ?? Promise.resolve();
    const current = previous.then(async () => {
      const hostMessages = await readOpenCodeMessages(client, sessionId, messageLimit);
      const hostHasAssistantText = hostMessages.some(
        (message) => message.role === "assistant" && message.content?.trim(),
      );
      const completedText = [...(pendingCompletedText.get(sessionId)?.parts.values() ?? [])].join(
        "\n",
      );
      const messages = withCompletedAssistantText(hostMessages, completedText);
      const transcript = JSON.stringify(messages);
      if (deliveredTranscripts.get(sessionId) === transcript) return;
      for (const handler of turnHandlers) await handler({ sessionId, messages });
      deliveredTranscripts.set(sessionId, transcript);
      if (hostHasAssistantText) pendingCompletedText.delete(sessionId);
    });
    turnDispatches.set(sessionId, current);
    try {
      await current;
    } finally {
      if (turnDispatches.get(sessionId) === current) turnDispatches.delete(sessionId);
    }
  };

  const hooks: OpenCodeHooks = {
    async config(config) {
      configureOpenCodeMemoryPermission(config, options.root ?? defaultOpenCodeMemFlywheelRoot());
    },
    async event({ event }) {
      const type = readString(event, "type");
      const sessionId = extractSessionId(event);
      if (sessionId) lastSessionId = sessionId;
      if (type === "session.idle" && sessionId) {
        await dispatchCompletedTurn(sessionId);
      }
      if (type === "session.deleted" && sessionId) {
        for (const handler of sessionEndHandlers) await handler({ sessionId });
        pendingCompletedText.delete(sessionId);
        deliveredTranscripts.delete(sessionId);
        turnDispatches.delete(sessionId);
      }
    },
    async "chat.message"(input) {
      lastSessionId = input.sessionID;
    },
    async "chat.params"(input, output) {
      if (!options.resolveModel) hostModel = createOpenCodeHostModel(input, output);
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
      lastSessionId = input.sessionID;
      const existing = pendingCompletedText.get(input.sessionID);
      const pending =
        existing?.messageId === input.messageID
          ? existing
          : { messageId: input.messageID, parts: new Map<string, string>() };
      pending.parts.set(input.partID, output.text);
      pendingCompletedText.set(input.sessionID, pending);
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
      "agentic-tool-loop",
      "tool-trajectory",
    ]),
    resolveModel,
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
  const port = createOpenCodeHarnessPort(input.client, { ...options, root });
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
