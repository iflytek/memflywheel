import {
  createOpenAIChatCompletionsModel,
  type CanonicalModelCompletion,
  type OpenAIChatCompletionsModelConfig,
} from "@memflywheel/model";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface OpenAICompatibleEnvModelOptions {
  readonly env?: EnvLike;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ResolvedOpenAICompatibleEnvModelConfig {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
}

const ENDPOINT_KEYS = [
  "MEMFLYWHEEL_LLM_ENDPOINT",
  "MEMFLYWHEEL_LLM_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "DEEPSEEK_BASE_URL",
  "CUSTOM_BASE_URL",
] as const;

const API_KEY_KEYS = [
  "MEMFLYWHEEL_LLM_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "CUSTOM_API_KEY",
] as const;

const MODEL_KEYS = [
  "MEMFLYWHEEL_LLM_MODEL",
  "OPENAI_MODEL",
  "DEEPSEEK_MODEL",
  "CUSTOM_MODEL",
] as const;

function envValue(env: EnvLike, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  return endpoint.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
}

export function resolveOpenAICompatibleEnvModelConfig(
  options: OpenAICompatibleEnvModelOptions = {},
): ResolvedOpenAICompatibleEnvModelConfig {
  const env = options.env ?? process.env;
  return {
    endpoint: normalizeEndpoint(options.endpoint ?? envValue(env, ENDPOINT_KEYS)),
    apiKey: options.apiKey ?? envValue(env, API_KEY_KEYS),
    model: options.model ?? envValue(env, MODEL_KEYS),
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    fetchImpl: options.fetchImpl,
  };
}

export function createOpenAICompatibleEnvModel(
  options: OpenAICompatibleEnvModelOptions = {},
): CanonicalModelCompletion {
  const config = resolveOpenAICompatibleEnvModelConfig(options);
  const modelConfig: OpenAIChatCompletionsModelConfig = {};
  if (config.endpoint) modelConfig.endpoint = config.endpoint;
  if (config.apiKey) modelConfig.apiKey = config.apiKey;
  if (config.model) modelConfig.model = config.model;
  if (config.maxTokens !== undefined) modelConfig.maxTokens = config.maxTokens;
  if (config.temperature !== undefined) modelConfig.temperature = config.temperature;
  if (config.fetchImpl) modelConfig.fetchImpl = config.fetchImpl;
  return createOpenAIChatCompletionsModel(modelConfig);
}
