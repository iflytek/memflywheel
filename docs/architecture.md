# Architecture

MemFlywheel is a file-backed long-term memory kernel for Agent Harnesses. It has
four runtime paths: recall, extraction, dream consolidation, and skill learning.
The core package owns filesystem correctness; the host owns lifecycle events,
model access, authentication, prompt assembly, and tool execution policy.

![MemFlywheel lifecycle hooks](assets/readme/02-lifecycle.png)

## System Shape

```text
Host Agent Harness
   │ owns lifecycle, model channel, auth, tool policy
   ▼
@memflywheel/adapters
   │ maps host events and payloads
   ▼
@memflywheel/sdk
   │ orchestrates recall, extraction, dream, skill loop
   ▼
@memflywheel/core
   │ validates and writes file-native memory
   ▼
memory-root + skills-root
```

| Layer | Responsibility |
|---|---|
| `@memflywheel/core` | Filesystem storage, schema validation, index rebuilds, locks, privacy checks, audit, ordinary file tools |
| `@memflywheel/model` | Canonical tool-calling model protocol and OpenAI-compatible mapper |
| `@memflywheel/sdk` | Lifecycle hooks, extraction/dream runners, skill-loop orchestration |
| `@memflywheel/skills` | Learned-skill staging, validation, finalize, rollback, recall routing |
| `@memflywheel/adapters` | Thin host mappings for Pi, Hermes, OpenClaw, OpenCode, Claude Code, Codex, and similar hosts |

## File-Native Storage

The Markdown files are the source of truth. `MEMORY.md` is only a rebuildable
index derived from those files.

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

| Path | Purpose |
|---|---|
| `identity/*.md` | Long-term identity and stable facts |
| `preference/*.md` | User preferences |
| `style/*.md` | Expression and collaboration style |
| `workflow/*.md` | Workflow experience and repeatable procedures |
| `context/*.md` | Current context, with aging hints |
| `ambient/*.md` | Background facts, with aging hints |
| `.memflywheel/sources/*.jsonl` | Cleaned raw conversation and tool trajectories |
| `.memflywheel/index/*` | Index-layer retrieval cache |

Each memory file is Markdown body plus YAML frontmatter:

```md
---
type: style
name: concise-structured-collaboration
description: The user prefers direct, structured engineering collaboration.
retrieval_terms:
  - direct answer
  - structured explanation
created_at: 2026-06-24T10:00:00.000Z
updated_at: 2026-06-24T10:00:00.000Z
---

The user prefers concise engineering answers that start with the concrete
conclusion before expanding into details.

## Sources

- .memflywheel/sources/session-20260624-collaboration.jsonl#L10-L18
```

## Recall

Recall is progressive reading, not full memory stuffing. Prompt-build injects
stable memory rules and lightweight `MEMORY.md` index cues. The main Agent then
decides whether to read the full memory body and, if needed, the source trace.

```text
User query
   │
   ▼
MEMORY.md index cues
   │
   ├─ small index -> inject full index
   └─ large index -> embedding + BM25 + RRF over index lines
   ▼
selected memory Markdown body
   ▼
.memflywheel/sources/*.jsonl evidence lines
```

Pre-retrieval only ranks index fields (`name`, `description`, `occurred_on`,
`retrieval_terms`, `type`, `path`). It does not embed memory bodies or raw
source traces.

## Extraction

Turn-end extraction converts a run into durable memories.

| Step | Owner | What happens |
|---|---|---|
| Trigger | Host / SDK | Host sends normalized transcript and tool trajectory |
| Windowing | Core | New messages are selected with cursor context |
| Source trace | Core | Newly processed messages are appended to JSONL |
| Memory writing | Injected runner + core tools | The subagent uses ordinary file tools to write validated memories |
| Finalize | Core | Relocate invalid root files, rebuild index, advance cursor only on success |

The model-driven step is injected as an `ExtractionAgentRunner`. Core still owns
validation, privacy filtering, locks, atomic writes, audit, and index sync.

## Dream Consolidation

Dream is an idle/scheduled maintenance pass, not a free-form summarizer.

| Phase | Model? | Purpose |
|---|---|---|
| Deterministic pre-pass | No | Delete identical duplicates and relocate path/type mismatches |
| Consolidation subagent | Yes, injected | Merge, compress, archive, and repair semantic memory structure through file tools |

`shouldRunDream` gates the pass by elapsed time or session count. The pass runs
under a consolidation lock and uses the same atomic write and audit path as
extraction.

## Skill Learning Loop

![MemFlywheel learning flywheel](assets/readme/05-skill-flywheel.png)

Repeated workflows can become learned skills. The skill loop runs after a
successful extraction pass when the host provides tool-call trajectory and skill
store wiring.

```text
turn-end transcript + tool calls
   │
   ▼
memory extraction
   │
   ▼
skill evolution agent
   │ writes staged skill package
   ▼
validate + finalize / rollback
   │
   ▼
dream compresses memory into skill cues
   │
   ▼
prompt-build injects learned-skill routes
```

The model does not get to self-declare success. The store derives whether a
create, update, merge, or no-op happened from the real filesystem change set,
then validates and finalizes it.

## Reliability Boundaries

| Concern | Current rule |
|---|---|
| Privacy | `<private>...</private>` spans are redacted; optional `refuseSecrets` rejects obvious secrets |
| Locking | Per-root file locks serialize writers and reclaim stale locks |
| Atomicity | Writes use temp-file plus rename |
| Audit | Writes, deletes, and archives append to `.audit.log` |
| Model boundary | Core never reads API keys or owns model transport |
| Host boundary | Host decides lifecycle timing, prompt placement, model channel, and tool policy |
