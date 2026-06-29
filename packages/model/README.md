# @memflywheel/model

Provider-neutral tool-calling model protocol for MemFlywheel.

This package is the only model shape consumed by `@memflywheel/sdk` subagent
loops. Host runtimes and providers map their native model APIs into
`CanonicalModelCompletion`; memory, dream, and skill-learning code never consumes
provider wire fields directly.

## Contract

```ts
import type { CanonicalModelCompletion } from "@memflywheel/model";

const model: CanonicalModelCompletion = {
  complete: async (req) => {
    // req.messages: canonical system/user/assistant/tool messages
    // req.tools: canonical tool definitions with JSON schemas
    return {
      message: {
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            name: "write",
            input: { filePath: "preference/example.md", content: "..." },
          },
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
import { createOpenAIChatCompletionsModel } from "@memflywheel/model";

const model = createOpenAIChatCompletionsModel({
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: process.env.MEMFLYWHEEL_LLM_API_KEY,
});
```

Environment variables:

| Variable                     | Meaning                                    |
| ---------------------------- | ------------------------------------------ |
| `MEMFLYWHEEL_LLM_ENDPOINT`   | Base URL without `/chat/completions`       |
| `MEMFLYWHEEL_LLM_API_KEY`    | API key, with `OPENAI_API_KEY` as fallback |
| `MEMFLYWHEEL_LLM_MODEL`      | Model id                                   |
| `MEMFLYWHEEL_LLM_MAX_TOKENS` | Output token cap                           |

## OpenAI-Compatible Embeddings Mapper

```ts
import { createOpenAIEmbeddingsModel } from "@memflywheel/model";

const embeddings = createOpenAIEmbeddingsModel({
  endpoint: "https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1",
  model: "@cf/baai/bge-m3",
  apiKey: process.env.MEMFLYWHEEL_EMBEDDING_API_KEY,
});
```

This mapper is for optional `MEMORY.md` index-layer retrieval. It does not embed
memory bodies and it does not make MemFlywheel a vector database.

| Variable                                                            | Meaning                                    |
| ------------------------------------------------------------------- | ------------------------------------------ |
| `MEMFLYWHEEL_EMBEDDING_ENDPOINT` / `MEMFLYWHEEL_EMBEDDING_BASE_URL` | Base URL without `/embeddings`             |
| `MEMFLYWHEEL_EMBEDDING_API_KEY`                                     | API key, with `OPENAI_API_KEY` as fallback |
| `MEMFLYWHEEL_EMBEDDING_MODEL`                                       | Embedding model id                         |

OpenAI-compatible HTTP is just one mapper. Native host adapters should prefer
the host-owned model/auth/lifecycle channel.
