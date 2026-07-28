/** Embedding-only infrastructure. Write-side LLM execution belongs to Pi Agent Core. */

export interface EmbeddingProvider {
  embed(request: { texts: string[]; signal?: AbortSignal }): Promise<{ vectors: number[][] }>;
}

export interface OpenAIEmbeddingsModelConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1";
const DEFAULT_MODEL = "text-embedding-3-small";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function apiKey(config: OpenAIEmbeddingsModelConfig): string {
  const value = config.apiKey ?? env("MEMFLYWHEEL_EMBEDDING_API_KEY") ?? env("OPENAI_API_KEY");
  if (!value) {
    throw new Error(
      "MemFlywheel embeddings model has no API key. Set MEMFLYWHEEL_EMBEDDING_API_KEY or OPENAI_API_KEY.",
    );
  }
  return value;
}

function endpoint(config: OpenAIEmbeddingsModelConfig): string {
  return (
    config.endpoint ??
    env("MEMFLYWHEEL_EMBEDDING_ENDPOINT") ??
    env("MEMFLYWHEEL_EMBEDDING_BASE_URL") ??
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, "");
}

function batchSize(config: OpenAIEmbeddingsModelConfig): number | undefined {
  const value =
    config.batchSize ?? Number.parseInt(env("MEMFLYWHEEL_EMBEDDING_BATCH_SIZE") ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseResponse(json: unknown, expected: number): number[][] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error("MemFlywheel embeddings model returned an invalid embedding count.");
  }
  return data.map((row, index) => {
    const vector = (row as { embedding?: unknown })?.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error(`MemFlywheel embeddings model returned an invalid vector at ${index}.`);
    }
    return vector;
  });
}

export function createOpenAIEmbeddingsModel(
  config: OpenAIEmbeddingsModelConfig = {},
): EmbeddingProvider {
  const baseUrl = endpoint(config);
  const model = config.model ?? env("MEMFLYWHEEL_EMBEDDING_MODEL") ?? DEFAULT_MODEL;
  const size = batchSize(config);
  const request = config.fetchImpl ?? fetch;

  return {
    async embed({ texts, signal }) {
      const vectors: number[][] = [];
      const batch = size ?? Math.max(texts.length, 1);
      for (let offset = 0; offset < texts.length; offset += batch) {
        const input = texts.slice(offset, offset + batch);
        const response = await request(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey(config)}`,
          },
          body: JSON.stringify({ model, input }),
          signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `MemFlywheel embeddings request failed (${response.status}). ${detail}`.trim(),
          );
        }
        vectors.push(...parseResponse(await response.json(), input.length));
      }
      return { vectors };
    },
  };
}
