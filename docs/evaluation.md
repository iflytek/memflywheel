# Evaluation

This page keeps benchmark and regression details out of the README.

## LoCoMo Position

On LoCoMo Cat1/2/4, MemFlywheel currently reports:

| Metric          |   Result | Setup                                                     |
| --------------- | -------: | --------------------------------------------------------- |
| LLM-judge score | `81.23%` | Local `bge-m3` embeddings, DeepSeek V4 Flash answer/judge |
| Token-F1        | `65.93%` | Same run                                                  |

Model choice matters because MemFlywheel is agent-driven. The same file-native
memory store can score differently when the answer, judge, extraction, or recall
model changes.

## Public Comparison Context

Only LoCoMo-related systems with a paper, official benchmark page, or official
repository are listed here.

| System                                                                                                                                                       |                                                             Public result | Source / practice                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------ |
| [LoCoMo](https://github.com/snap-research/locomo)                                                                                                            |                                                                 benchmark | Official ACL 2024 long-conversation memory benchmark                                       |
| [Mem0](https://github.com/mem0ai/mem0) / [paper](https://arxiv.org/html/2504.19413v1)                                                                        |                                               67.13% paper / 92.5% latest | Multi-level memory, fact extraction, vector / graph retrieval                              |
| [MemMachine](https://github.com/MemMachine/MemMachine) / [paper](https://arxiv.org/abs/2604.04853)                                                           |                                                                    91.69% | Full conversational episodes and contextualized retrieval                                  |
| [Honcho](https://github.com/plastic-labs/honcho) / [eval](https://honcho.dev/evals/)                                                                         |                                                                     89.9% | Memory-agent service with user / agent / group modeling                                    |
| **MemFlywheel current run**                                                                                                                                  | qwen/qwen3.7-plus: 87.12%; DeepSeek V4 Flash: 81.23%; GPT-4o-mini: 76.89% | File-native memory; Agent recalls through index, memory body, source trace, and tool calls |
| [Memori](https://memorilabs.ai/docs/memori-cloud/benchmark/results/)                                                                                         |                                                                    81.95% | Semantic triples plus conversation summaries                                               |
| [Zep / Graphiti](https://help.getzep.com/graphiti/getting-started/overview)                                                                                  |                                                             75.14%-80.00% | Temporal knowledge graph retrieval                                                         |
| [Memobase](https://github.com/memodb-io/memobase) / [benchmark](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md) |                                                                    75.78% | User profile plus event timeline                                                           |
| [Letta Filesystem](https://www.letta.com/blog/benchmarking-ai-agent-memory/)                                                                                 |                                                                    74.00% | Filesystem retrieval with search / grep / open                                             |
| [LangMem](https://langchain-ai.github.io/langmem/)                                                                                                           |                                                             58.10%-78.05% | LangGraph BaseStore memories                                                               |
| [MemoryOS](https://github.com/BAI-LAB/MemoryOS) / [paper](https://arxiv.org/html/2506.06326v1)                                                               |                                               F1 +49.11% / BLEU-1 +46.18% | Hierarchical short / mid / long-term memory                                                |
| [A-Mem](https://github.com/agiresearch/A-mem) / [paper](https://arxiv.org/html/2502.12110v11)                                                                |                                                       LoCoMo F1 / ROUGE-L | Zettelkasten-style dynamic notes, tags, and linking                                        |
| [SimpleMem](https://github.com/aiming-lab/SimpleMem) / [paper](https://arxiv.org/html/2601.02553v1)                                                          |                                                                  43.24 F1 | Structured compression plus query-aware retrieval                                          |

## Local Regression Checks

| Area       | What is checked                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Extraction | Tool-calling subagent writes validated memories, preserves source refs, refuses private data when configured |
| Dream      | Deterministic pre-pass plus consolidation runner keeps the store valid                                       |
| Recall     | `MEMORY.md` rebuild, truncation, aging hints, index-layer retrieval, and prompt segments                     |
| Skill loop | Staged skill changes are validated, finalized, rolled back, and routed into recall                           |

Run the repository check before reporting results:

```sh
pnpm run ci
```
