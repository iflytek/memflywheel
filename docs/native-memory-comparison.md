# Host-Native Long-Term Memory Comparison

Comparison of long-term memory capabilities and cost across MemFlywheel, Pi, Hermes, OpenClaw, and OpenCode.

## Capability Comparison

| System          | Native long-term memory | Storage and extraction                                                                              | Recall and maintenance                                                                                             |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Pi native       | No                      | —                                                                                                   | —                                                                                                                  |
| Hermes native   | Yes                     | Capacity-bounded `MEMORY.md` and `USER.md`, managed by the Agent memory tool and background review  | Injects a bounded snapshot into future Sessions; the Agent must replace, remove, or compress entries at capacity   |
| OpenClaw native | Yes                     | `MEMORY.md`, dated `memory/*.md` notes, optional `DREAMS.md`, and a memory index                    | `memory_search` and `memory_get`; keyword, vector, or hybrid retrieval; optional dreaming                          |
| OpenCode native | No                      | —                                                                                                   | —                                                                                                                  |
| MemFlywheel     | Yes                     | Typed Markdown memories written by a turn-end extraction Agent, with source traces and an audit log | Index cues route the main Agent to relevant bodies; gated dream consolidation and optional learned-skill evolution |

## Long-Term Memory Cost

| Metric                  | Calculation                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| Total cost              | `Prompt increase + extraction + consolidation + recall + index`         |
| Total overhead          | `long-term memory cost / host cost with long-term memory disabled`      |
| Foreground prompt tax   | `additional foreground input tokens / baseline foreground input tokens` |
| LLM write amplification | `memory write-side model tokens / new conversation tokens`              |
| Recall amplification    | `recall-path tokens / user-query tokens`                                |
| Maintenance cost / turn | `(skill evolution + dream) / completed turns`                           |
| Model cost              | `Σ(input tokens × input price + output tokens × output price)`          |

| System          | Foreground cost                                               | Write-side cost                                                      | Maintenance and retrieval                                       | Dominant cost shape                                   |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Hermes native   | Approximately 1,300 bounded memory tokens accompany inference | Main Agent memory-tool writes; background review every 10 user turns | Context-resident snapshot; no separate retrieval                | Fixed prompt tax + infrequent upkeep                  |
| OpenClaw native | Bounded `MEMORY.md`; the Codex harness uses a retrieval cue   | Main Agent file writes; memory flush before compaction               | On-demand BM25/vector recall; dreaming off by default           | Low write cost + on-demand recall                     |
| MemFlywheel     | Bounded index cues; bodies are read progressively             | Extraction Agent after every turn, with multi-round file-tool access | Optional skill evolution; dream after five Sessions or 24 hours | **High write amplification** + periodic consolidation |

MemFlywheel uses **eager agentic consolidation**: per-turn extraction, rather than Markdown, indexing, or storage, dominates its cost.

### Normalized Workload Estimate

| Parameter        | Value                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload         | 100 turns / 10 Sessions; average 8,000 input and 800 output tokens per turn                                                                                             |
| Memory activity  | 20% of turns write durable memory; 20% perform recall, injecting 800 tokens                                                                                             |
| Cache            | 80% hit rate for main input; 90%–99% for stable prompts/indexes; new conversation content, tool results, and recalled bodies count as misses                            |
| Pricing weights  | Normalized from [DeepSeek V4 Flash pricing](https://api-docs.deepseek.com/quick_start/pricing/) on 2026-07-14: cache-hit input `0.02`, cache-miss input `1`, output `2` |
| Hermes           | 1,300-token snapshot; one review every 10 user turns, taking 1–3 rounds                                                                                                 |
| OpenClaw         | 1,000-token `MEMORY.md`; four compaction flushes; dreaming disabled                                                                                                     |
| MemFlywheel Core | Approximately 3,900-token extraction prompt; one round for 80% of turns and 2–4 rounds for 20%                                                                          |
| MemFlywheel Full | Core + low-frequency skill evolution + two dream passes                                                                                                                 |
| Baseline cost    | `100 × [8,000 × (80% × 0.02 + 20% × 1) + 800 × 2] = 332,800 cost units`                                                                                                 |

### Estimated Results

| System                      | Resident prompt and recall | Write and maintenance | Incremental cost units | Total model-cost increase |
| --------------------------- | -------------------------- | --------------------- | ---------------------- | ------------------------- |
| Hermes native               | `+1%–5%`                   | `+3%–10%`             | `12K–47K`              | **`+4%–15%`**             |
| OpenClaw native (Codex)     | `+4%–6%`                   | `+1%–3%`              | `19K–27K`              | **`+6%–9%`**              |
| OpenClaw native (non-Codex) | `+6%–9%`                   | `+1%–3%`              | `22K–39K`              | **`+7%–12%`**             |
| MemFlywheel Core            | `+6%–9%`                   | `+56%–80%`            | `207K–294K`            | **`+65%–90%`**            |
| MemFlywheel Full loop       | `+6%–9%`                   | `+67%–107%`           | `242K–384K`            | **`+75%–115%`**           |

MemFlywheel spends approximately `65%–115%` more model budget on per-turn semantic extraction, in-place revision, deduplication, provenance, and continuing evolution. These are architectural estimates under normalized parameters; actual percentages should come from model usage telemetry.
