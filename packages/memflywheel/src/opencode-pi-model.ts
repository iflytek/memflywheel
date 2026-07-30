import type {
  Api,
  Model,
  OpenAICompletionsCompat,
  ProviderStreams,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { PiAgentModelBinding } from "@memflywheel/sdk";

type RawRecord = Record<string, unknown>;

export interface OpenCodePiModelConfig {
  readonly api: Api;
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly requestMaxTokens?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly compat?: OpenAICompletionsCompat;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly temperature?: number;
  readonly requestOptions?: RawRecord;
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function withProviderFetch<T>(fetchImpl: typeof globalThis.fetch, run: () => T): T {
  // Provider SDKs capture the default fetch while streamSimple constructs their
  // client. Restore it before any asynchronous network work can interleave.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  globalThis.fetch = fetchImpl;
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
    else delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
  }
}

async function loadApi(api: Api): Promise<ProviderStreams> {
  switch (api) {
    case "openai-completions":
      return import("@earendil-works/pi-ai/api/openai-completions");
    case "openai-responses":
      return import("@earendil-works/pi-ai/api/openai-responses");
    case "openai-codex-responses":
      return import("@earendil-works/pi-ai/api/openai-codex-responses");
    case "azure-openai-responses":
      return import("@earendil-works/pi-ai/api/azure-openai-responses");
    case "anthropic-messages":
      return import("@earendil-works/pi-ai/api/anthropic-messages");
    case "google-generative-ai":
      return import("@earendil-works/pi-ai/api/google-generative-ai");
    case "google-vertex":
      return import("@earendil-works/pi-ai/api/google-vertex");
    case "bedrock-converse-stream":
      return import("@earendil-works/pi-ai/api/bedrock-converse-stream");
    case "mistral-conversations":
      return import("@earendil-works/pi-ai/api/mistral-conversations");
    default:
      throw new Error(`MemFlywheel has no pi-ai loader for API ${api}.`);
  }
}

export function createPiAiModelBinding(config: OpenCodePiModelConfig): PiAgentModelBinding {
  const model: Model<Api> = {
    id: config.model,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    input: config.input,
    cost: zeroCost,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.compat ? { compat: config.compat } : {}),
    ...(config.thinkingLevelMap ? { thinkingLevelMap: config.thinkingLevelMap } : {}),
  };

  return {
    model,
    ...(config.apiKey ? { getApiKey: () => config.apiKey } : {}),
    request: {
      ...(config.requestOptions ?? {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.env ? { env: config.env } : {}),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.requestMaxTokens === undefined ? {} : { maxTokens: config.requestMaxTokens }),
    },
    streamFn: async (activeModel, context, options) => {
      const api = await loadApi(activeModel.api);
      const stream = () => api.streamSimple(activeModel, context, options);
      return config.fetch ? withProviderFetch(config.fetch, stream) : stream();
    },
  };
}
