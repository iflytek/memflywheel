# MemFlywheel

<p align="center">
  <img src="docs/assets/brand/memflywheel-icon.png" alt="MemFlywheel icon" width="96" height="96">
</p>

Turn every Agent run into a smarter start for the next one.

MemFlywheel is a file-native long-term memory and skill-learning layer for AI Agent Harnesses. It turns preferences, tool trajectories, project conventions, failure lessons, and repeated workflows into inspectable, diffable, reusable Markdown memories and learned skills.

![MemFlywheel overview](docs/assets/readme/01-overview.png)

## Why MemFlywheel

Most Agent memory systems put memories into a memory store, vector database, or knowledge graph, then reuse them through retrieval or context injection. MemFlywheel instead starts from files and agent-native reading: it progressively exposes index cues, memory bodies, raw traces, and learned skills, turning preferences, failure lessons, and reusable procedures into auditable, portable, evolvable file assets.

| Dimension | Common memory systems | MemFlywheel |
|---|---|---|
| Focus | Memory storage, search recall, context injection | Execution experience capture, evidence traceability, skill evolution |
| Memory objects | Conversations, preferences, knowledge snippets | Preference understanding, project conventions, tool trajectories, failure lessons, repeated workflows |
| Storage shape | API, vector database, knowledge graph, framework store | Markdown memories, `MEMORY.md`, `.memflywheel/sources`, learned skills |
| Recall path | Retrieve relevant snippets and inject them into the prompt | Index cues -> memory body -> source trace -> learned skill |
| Learning loop | Usually focused on whether memory can be recalled | Repeated workflows become learned skills and feed back into long-term memory consolidation |
| Engineering governance | Depends on service or framework-internal state | Files are readable, diffable, archivable, and indexes are rebuildable |

## What MemFlywheel Is

| Dimension | Description |
|---|---|
| Positioning | A memory foundation component inside an Agent Harness |
| Storage | Markdown body + YAML frontmatter |
| Index | `MEMORY.md` is a rebuildable index; the LLM does not maintain it directly |
| Recall | prompt-build injects memory rules and index cues; the main Agent reads relevant files itself |
| Consolidation | the dream agent merges, compresses, archives, and repairs structure during idle or forced runs |
| Skills | reusable procedures are captured as `memflywheel-learned-*/SKILL.md` |
| Model | core does not call an LLM; model, auth, and lifecycle are injected by the host or SDK |
| Integration | SDK and adapters connect to hosts such as Pi, Hermes, OpenClaw, and OpenCode |

## LoCoMo Evaluation Position

On the LoCoMo Cat1/2/4 evaluation, MemFlywheel currently achieves an `81.23%` LLM-judge score and a `65.93%` token-F1. This run uses local `bge-m3` embeddings, with DeepSeek V4 Flash as the answer/judge model.

The table below only includes LoCoMo-related projects backed by papers, official benchmark pages, or official repositories.

| System | Public Result | Source / Practice |
|---|---:|---|
| [LoCoMo](https://github.com/snap-research/locomo) | benchmark | Official ACL 2024 benchmark for long-conversation memory QA, summary, and multimodal-dialog evaluation |
| [Mem0](https://github.com/mem0ai/mem0) / [paper](https://arxiv.org/html/2504.19413v1) | 67.13% paper / 92.5% latest | The paper and latest official benchmark use different setups; practice: multi-level memory, fact extraction, vector / graph retrieval |
| [MemMachine](https://github.com/MemMachine/MemMachine) / [paper](https://arxiv.org/abs/2604.04853) | 91.69% | arXiv 2026; preserves full conversational episodes and uses contextualized retrieval |
| [Honcho](https://github.com/plastic-labs/honcho) / [eval](https://honcho.dev/evals/) | 89.9% | Official eval page; a memory-agent service that models users, agents, groups, and other peers |
| **MemFlywheel current run** | qwen/qwen3.7-plus: 87.12%; DeepSeek V4 Flash: 81.23%; GPT-4o-mini: 76.89% | Local experiment; file-native memory where the Agent recalls and answers through indexes, memory bodies, source traces, and tool calls |
| [Memori](https://memorilabs.ai/docs/memori-cloud/benchmark/results/) | 81.95% | Official results docs; practice: semantic triples + conversation summaries |
| [Zep / Graphiti](https://help.getzep.com/graphiti/getting-started/overview) | 75.14%-80.00% | Zep blog / Memori table use different setups; practice: temporal knowledge graph combining time, semantic, and graph retrieval |
| [Memobase](https://github.com/memodb-io/memobase) / [benchmark](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md) | 75.78% | Official benchmark repo; practice: user profile + event timeline for personalized context |
| [Letta Filesystem](https://www.letta.com/blog/benchmarking-ai-agent-memory/) | 74.00% | Letta blog; practice: put LoCoMo conversations into a filesystem and let the agent retrieve with file search / grep / open |
| [LangMem](https://langchain-ai.github.io/langmem/) | 58.10%-78.05% | MemMachine / Memori tables differ; practice: LangGraph BaseStore + semantic / episodic / procedural memories |
| [MemoryOS](https://github.com/BAI-LAB/MemoryOS) / [paper](https://arxiv.org/html/2506.06326v1) | F1 +49.11% / BLEU-1 +46.18% | EMNLP 2025 Oral; hierarchical memory OS with dynamic short / mid / long-term updates |
| [A-Mem](https://github.com/agiresearch/A-mem) / [paper](https://arxiv.org/html/2502.12110v11) | LoCoMo F1 / ROUGE-L | Paper / OpenReview; Zettelkasten-style dynamic notes, tags, and memory linking |
| [SimpleMem](https://github.com/aiming-lab/SimpleMem) / [paper](https://arxiv.org/html/2601.02553v1) | 43.24 F1 | arXiv / project page; semantic structured compression + adaptive query-aware retrieval |

MemFlywheel is an agent-driven memory system. Its final performance depends to some extent on the answer/judge model and on the agentic ability of the models used in extraction and recall. With the same file-native memory structure, different models show different tool-use, evidence-location, and answer-synthesis capabilities.

## Core Flow

![MemFlywheel lifecycle hooks](docs/assets/readme/02-lifecycle.png)

## File-Native Storage

The source of truth in MemFlywheel is the Markdown files under the memory root. `MEMORY.md` is only an index rebuilt from those files.

```text
memory-root/
├─ MEMORY.md
├─ identity/*.md
├─ preference/*.md
├─ style/*.md
├─ workflow/*.md
├─ context/*.md
├─ ambient/*.md
└─ .memflywheel/
   ├─ sources/*.jsonl
   └─ index/*

skills-root/
└─ memflywheel-learned-*/SKILL.md
```

These directories are the default memory categories. Integrators can adjust the category granularity for their project, user, or business domain.

| Path | Purpose |
|---|---|
| `identity/*.md` | Long-term identity and stable facts |
| `preference/*.md` | User preferences |
| `style/*.md` | Expression style and collaboration style |
| `workflow/*.md` | Workflow experience |
| `context/*.md` | Current context, with a default 30-day verification hint |
| `ambient/*.md` | Background facts, with a default 30-day verification hint |
| `MEMORY.md` | Derived index, rebuildable, not the source of truth |
| `.memflywheel/sources/*.jsonl` | Cleaned raw conversation and tool trajectories for on-demand deep reading |
| `.memflywheel/index/*` | Index-layer retrieval cache |
| `memflywheel-learned-*/SKILL.md` | learned skill package |

Each memory file is a Markdown body plus YAML frontmatter:

```md
---
type: style
name: concise-structured-collaboration
description: The user prefers direct, structured engineering collaboration with clear boundaries and visible tradeoffs.
retrieval_terms:
  - direct answer
  - structured explanation
  - engineering tradeoff
  - ASCII diagram
  - clear boundaries
created_at: 2026-06-24T10:00:00.000Z
updated_at: 2026-06-24T10:00:00.000Z
---

The user prefers concise engineering answers that start with the concrete conclusion before expanding into details. When explaining mechanisms, define the term first, then describe who does what, when it runs, and how it is triggered. For comparisons, tradeoffs, workflows, and architecture, compact tables or ASCII diagrams are preferred over long prose. The user dislikes vague summaries, hidden assumptions, and compatibility patches that obscure the real boundary.

## Sources

- .memflywheel/sources/session-20260624-collaboration.jsonl#L10-L18
- .memflywheel/sources/session-20260624-collaboration.jsonl#L31-L37
```

## Progressive Recall and Index-Layer Pre-Retrieval

MemFlywheel does not put every memory body into the prompt. It first injects index cues and lets the main business Agent decide whether to read complete memory files.

```text
●  User query / current task
        │
        ▼
●  MEMORY.md index records
        │
        ├─▸ small index  →  inject full MEMORY.md cues
        ├─▸ large index  →  embedding + BM25 + RRF over index lines
        │                →  inject topN relevant paths
        ▼
●  Main Agent reads selected *.md files
        │
        ▼
●  If body is not enough → read .memflywheel/sources/*.jsonl line ranges
```

Pre-retrieval only runs over the `MEMORY.md` index layer:

| Field | Used by pre-retrieval |
|---|---|
| `name` | Yes |
| `description` | Yes |
| `occurred_on` | Yes |
| `retrieval_terms` | Yes |
| `type` / `path` | Light sparse routing |
| memory body | No |
| `.memflywheel/sources` raw trace | No |

The goal is to keep context lightweight while preserving three-layer progressive reading:

```text
  Layer 1  ·  MEMORY.md index cues
     │
     ▼
  Layer 2  ·  selected memory Markdown body
     │
     ▼
  Layer 3  ·  source trace JSONL line ranges
```

## Learning Flywheel

![MemFlywheel learning flywheel](docs/assets/readme/05-skill-flywheel.png)

## Package Structure

| Package | Role |
|---|---|
| `@memflywheel/core` | File storage, frontmatter, index, recall, extraction and dream tools, privacy, locks, audit |
| `@memflywheel/model` | Provider-neutral tool-calling model protocol and OpenAI-compatible mapper |
| `@memflywheel/sdk` | Lifecycle hooks and extraction / dream / skill loop orchestration |
| `@memflywheel/skills` | learned skill file packages, staging, validation, finalize, rollback, recall routing |
| `@memflywheel/adapters` | Host lifecycle mapping for Pi, Hermes, OpenClaw, OpenCode, Claude Code, Codex, and similar hosts |

## Current Integration Status

MemFlywheel has abstracted host integration into SDK hooks, HostHarnessPort, and adapters. Pi is currently the deepest integration path. Other hosts already have adapters or markers, but whether they can run the full memory and skill loop depends on whether the host exposes lifecycle events, a structured tool-call model channel, and tool trajectories.

| Host | Current progress | Notes |
|---|---|---|
| Pi | Complete first-class path implemented | Pi adapter, Pi HarnessPort, lifecycle mapping, and canonical model mapping are in place; can support recall, extraction, dream, and skill loop |
| Hermes | Adapter skeleton available | Needs the Hermes plugin to expose a structured model capability such as `completeWithTools` before write-side loops can run |
| OpenClaw | recall-first adapter available | Currently focused on memory injection; native extraction / dream / skill loop still needs an OpenClaw model port |
| OpenCode | recall-first adapter available | Suitable for hook-native recall today; does not claim a full write-side loop before a host-owned tool-call model port exists |

## Pi Integration Example

Pi integration does not make MemFlywheel take over the model. Instead, Pi's lifecycle and tool-calling model channel are mapped into `HostHarnessPort`. The real entrypoint in this repository is `examples/pi/extension.mjs`:

```js
import { completeSimple } from "@earendil-works/pi-ai";
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "@memflywheel/adapters";

/** @param {any} pi - the Pi ExtensionAPI */
export default function memFlywheelExtension(pi) {
  const port = createPiHarnessPort(pi, { completeSimple });
  const runtime = createMemFlywheelHarnessRuntime({ port });

  if (typeof pi.onDispose === "function") pi.onDispose(runtime.dispose);
  return runtime.dispose;
}
```

Local smoke test:

```sh
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

Model integration principles:

| Scenario | Approach |
|---|---|
| Host already has a model channel | Map the host's structured tool-call completion into the canonical model and pass it to extraction / dream / skill loop |
| Local examples or benchmarks | Use the OpenAI-compatible mapper in `@memflywheel/model` to connect external models |
| core | Does not read API keys, does not own model service, does not route models |

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm run ci
```

## Open-Source Boundary

MemFlywheel is intended to be a long-term memory and skill-learning foundation component inside an Agent Harness. It stays file-native, model-agnostic, and host-first; it does not absorb the main Agent, model service, tool permissions, or skill execution into itself.
