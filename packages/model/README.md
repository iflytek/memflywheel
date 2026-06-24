# @memscribe/model

Provider-neutral tool-calling model protocol for MemScribe.

This package is the only model shape consumed by `@memscribe/sdk` subagent
loops. Host runtimes and providers map their native model APIs into
`CanonicalModelCompletion`; memory, dream, and skill-learning code never consumes
provider wire fields directly.

## Contract

```ts
import type { CanonicalModelCompletion } from "@memscribe/model";

const model: CanonicalModelCompletion = {
  complete: async (req) => {
    // req.messages: canonical system/user/assistant/tool messages
    // req.tools: canonical tool definitions with JSON schemas
    return {
      message: {
        role: "assistant",
        toolCalls: [
          { id: "call-1", name: "write", input: { filePath: "preference/example.md", content: "..." } },
        ],
      },
      finishReason: "tool-calls",
    };
  },
};
```

Tool call inputs are structured values, not JSON strings. If a provider uses
JSON-string arguments, its mapper must parse them before returning canonical
tool calls and fail on malformed input.

## OpenAI-Compatible Mapper

```ts
import { createOpenAIChatCompletionsModel } from "@memscribe/model";

const model = createOpenAIChatCompletionsModel({
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: process.env.MEMSCRIBE_LLM_API_KEY,
});
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `MEMSCRIBE_LLM_ENDPOINT` | Base URL without `/chat/completions` |
| `MEMSCRIBE_LLM_API_KEY` | API key, with `OPENAI_API_KEY` as fallback |
| `MEMSCRIBE_LLM_MODEL` | Model id |
| `MEMSCRIBE_LLM_MAX_TOKENS` | Output token cap |

## OpenAI-Compatible Embeddings Mapper

```ts
import { createOpenAIEmbeddingsModel } from "@memscribe/model";

const embeddings = createOpenAIEmbeddingsModel({
  endpoint: "https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1",
  model: "@cf/baai/bge-m3",
  apiKey: process.env.MEMSCRIBE_EMBEDDING_API_KEY,
});
```

This mapper is for optional `MEMORY.md` index-layer retrieval. It does not embed
memory bodies and it does not make MemScribe a vector database.

| Variable | Meaning |
| --- | --- |
| `MEMSCRIBE_EMBEDDING_ENDPOINT` / `MEMSCRIBE_EMBEDDING_BASE_URL` | Base URL without `/embeddings` |
| `MEMSCRIBE_EMBEDDING_API_KEY` | API key, with `OPENAI_API_KEY` as fallback |
| `MEMSCRIBE_EMBEDDING_MODEL` | Embedding model id |

OpenAI-compatible HTTP is just one mapper. Native host adapters should prefer
the host-owned model/auth/lifecycle channel.
