# MemFlywheel

Turn every Agent run into a smarter start for the next one.

MemFlywheel is a file-native long-term memory and skill-learning layer for AI
Agent Harnesses. It turns preferences, tool trajectories, project conventions,
failure lessons, and repeated workflows into inspectable, diffable, reusable
Markdown memories and learned skills.

![MemFlywheel overview](docs/assets/readme/01-overview.png)

## Why It Exists

Most Agent memory systems put memories into a memory store, vector database, or
knowledge graph, then reuse them through retrieval or context injection.
MemFlywheel keeps the source of truth in files and lets the Agent progressively
read index cues, memory bodies, source traces, and learned skills.

```text
Agent run
   │
   ├─ prompt-build  -> recall MEMORY.md index cues
   ├─ turn-end      -> extract durable memories from the run
   ├─ idle          -> consolidate and repair the memory store
   └─ repeated work -> evolve learned skills
```

## What It Provides

| Area | What MemFlywheel does |
|---|---|
| Storage | Markdown memories with YAML frontmatter |
| Index | Rebuildable `MEMORY.md`; not directly authored by the model |
| Recall | Injects lightweight index cues; the main Agent reads relevant files |
| Sources | Keeps cleaned JSONL traces for evidence-level backtracking |
| Consolidation | Merges, compresses, archives, and repairs memories during dream passes |
| Skills | Stores reusable procedures as `memflywheel-learned-*/SKILL.md` |
| Host boundary | Core owns files; host owns lifecycle, model access, auth, and tools |

## Quick Start

Run the offline Pi demo:

```sh
pnpm install
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

The demo drives prompt-build recall, turn-end extraction, and file-native memory
writes without calling an external model.

## Packages

| Package | Role |
|---|---|
| `@memflywheel/core` | Storage, frontmatter, index, recall, extraction/dream tools, privacy, locks, audit |
| `@memflywheel/model` | Provider-neutral tool-calling model protocol and OpenAI-compatible mapper |
| `@memflywheel/sdk` | Lifecycle hooks and extraction / dream / skill-loop orchestration |
| `@memflywheel/skills` | Learned skill packages, staging, validation, finalize, rollback, recall routing |
| `@memflywheel/adapters` | Host lifecycle mapping for Pi, Hermes, OpenClaw, OpenCode, Claude Code, Codex, and similar hosts |

## Documentation

| Document | Content |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Storage layout, recall, extraction, dream, skill loop, package boundaries |
| [`docs/integrations.md`](docs/integrations.md) | SDK hooks, adapter boundary, host capability levels |
| [`docs/evaluation.md`](docs/evaluation.md) | LoCoMo position and local regression checks |
| [`docs/release.md`](docs/release.md) | Versioning, npm release channel, publish checklist |

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm run ci
```

## Open-Source Boundary

MemFlywheel is a foundation component inside an Agent Harness. It stays
file-native, model-agnostic, and host-first; it does not absorb the main Agent,
model service, tool permissions, or skill execution into itself.
