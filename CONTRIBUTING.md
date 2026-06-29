# Contributing to MemFlywheel

Thanks for helping improve MemFlywheel.

MemFlywheel is a file-native long-term memory layer for AI agents. It is a memory
foundation component inside an Agent Harness, not a model, not an agent
framework, and not a vector database.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm run ci
```

## Design Boundaries

Please keep changes inside the public MemFlywheel scope:

| Area      | Rule                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Storage   | Markdown files plus YAML frontmatter are the source of truth.                                                        |
| Index     | `MEMORY.md` is a rebuildable index. Do not hand-edit it.                                                             |
| Recall    | Full-index recall only. Do not add embeddings, BM25, top-k, or vector search.                                        |
| LLM calls | `@memflywheel/core` must not call LLMs directly. Use injected runners or `@memflywheel/model` canonical model ports. |
| Naming    | Use `MemFlywheel`, `memflywheel`, `@memflywheel/*`, and `MEMFLYWHEEL_*`.                                             |

## Pull Requests

Before opening a PR:

1. Run `pnpm run ci`.
2. Check that package metadata points to `iflytek/memflywheel`.
3. Check that no secrets, private paths, old names, or AI-signature footers were added.
4. Keep commits focused and avoid unrelated formatting churn.

## Public Hygiene

Do not include credentials, private local paths, internal project names, or AI
generation footers/trailers.
