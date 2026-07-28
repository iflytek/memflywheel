# @memflywheel/embeddings

Optional embedding pre-recall for large `MEMORY.md` indexes. MemFlywheel's write-side model path does not use this package; Extraction, Dream, and Skill Evolution run on the host's active model through Pi Agent Core.

```ts
import { createOpenAIEmbeddingsModel } from "@memflywheel/embeddings";

const embeddingProvider = createOpenAIEmbeddingsModel({
  endpoint: "https://example.com/v1",
  apiKey: process.env.MEMFLYWHEEL_EMBEDDING_API_KEY,
  model: "bge-m3",
});
```

Configuration: `MEMFLYWHEEL_EMBEDDING_ENDPOINT`, `MEMFLYWHEEL_EMBEDDING_API_KEY`, `MEMFLYWHEEL_EMBEDDING_MODEL`, and `MEMFLYWHEEL_EMBEDDING_BATCH_SIZE`.
