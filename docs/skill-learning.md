# Skill Learning Loop

This document specifies MemScribe's opt-in skill learning loop without turning
the project into a full agent framework. Public names in this document are
MemScribe names only.

## Definition

MemScribe remains a **file-native long-term memory layer**:

| Boundary | Rule |
| --- | --- |
| Is | A local file-backed long-term memory layer for agent hosts. |
| Is not | A complete agent framework, vector database, hosted memory API, or RAG platform. |
| Owns | File layout, validation, locks, checkpoints, atomic writes, audit, recall packets, extraction and dream contracts. |
| Does not own | Host planning, tool execution policy, model routing, UI, conversation orchestration, or skill runtime invocation. |

The skill learning loop adds a second file-native artifact type: **skills**. A
skill is an executable procedure package that a host may load later. MemScribe
only stores, validates, and evolves it.

```
host runtime
  |
  | turn/session/idle packets
  v
MemScribe memory layer
  |
  +-- memory: what to know + short routing signals
  |
  +-- skills: executable SOP / procedure / templates
```

## Memory vs Skill

| Layer | Stores | Must not store | Read by |
| --- | --- | --- | --- |
| Memory | Stable facts, preferences, project context, and short trigger signals. | Complete numbered procedures, templates, scripts, or execution policy. | Main model via full-index recall and explicit `memory_read`. |
| Skill | Executable SOPs, checklists, templates, scripts, examples, validators. | User-private facts that belong in memory, session transcripts, host-only internals. | Host skill loader or future MemScribe skill APIs. |

Rule:

1. Memory may say: "For release prep, use the release-prep skill."
2. Memory must not contain the full release procedure.
3. Skill may contain the executable steps, templates, and validation scripts.
4. Dream may compress an over-long workflow memory into a trigger, but it must
   not invent or rewrite skill execution steps.

## Current Implementation

| Capability | Current state |
| --- | --- |
| File-native memory store | Implemented under the memory root with Markdown + YAML frontmatter. |
| Full-index recall | Implemented; no embeddings, no top-k, no BM25. |
| Extraction subagent | Implemented through `ExtractionAgentRunner`; writes through memory tools. |
| Dream consolidation | Implemented through deterministic pre-pass + `DreamAgentRunner`. |
| Dream coordination packet | Implemented for memory coordination: `reason`, `memoryAction`, `topics`. |
| Prompt skill routing | Implemented in `@memscribe/sdk` via `skillRecall`; `onPromptBuild()` and `context()` can inject learned-skill routes plus recent usage signals. |
| Skill usage feedback | Implemented in `@memscribe/sdk` via `recordSkillUsage()` / `getSkillUsageRecords()`. |
| Learning gate | Implemented in `@memscribe/sdk` as a deterministic skill-learning gate. |
| Turn-end learning loop | Implemented as opt-in `createMemScribe({ learningLoop })`; skill evolution only runs after extraction returns `Completed`. |
| Opt-in adapter assembly | Implemented in `@memscribe/adapters` via `createHostMemScribe({ toolCompletion, learnedSkills })`, which wires `@memscribe/skills`, `runSkillEvolutionAgent`, learned-skill recall, extraction, and dream over the same host `toolCompletion`. |
| Skill store | Implemented in `@memscribe/skills` as a file-native learned skill store. |
| Skill checkpoint/finalize/rollback | Implemented with staging, finalized skill tree diff checks, and snapshot rollback. |
| CLI/MCP skill injection | Not implemented by default. CLI and MCP remain memory-facing unless a host explicitly wires learned-skill recall through SDK hooks. |

## Public Naming Rule

Public docs, package names, comments, test names, and examples must use MemScribe
terms only.

| Allowed public term | Meaning |
| --- | --- |
| `SkillEvolutionRunner` | The model-driven runner that proposes skill package changes. |
| `LearningLoopGate` | The deterministic gate deciding whether skill evolution may run. |
| `CoordinationPacket` | Host-supplied directive connecting memory compression and skill evolution. |
| `SkillCheckpoint` | Snapshot used for strict finalize or rollback. |

Internal reference host names, old project names, and local experiment labels must
not appear in public docs or package APIs. They may appear only in private
handoff notes outside the public repository surface.

## Target Layout

Skills should live outside the memory scan path. The host passes a dedicated
`skillsRoot` to `@memscribe/skills`; memory scanning continues to see memory
documents only.

```
<skills-root>/
└── memscribe-learned-<slug>/
    ├── SKILL.md
    ├── .memscribe-skill.json
    ├── references/
    ├── templates/
    ├── scripts/
    └── assets/
```

Validation must fail fast. Do not auto-repair malformed skill packages.

| Field | Rule |
| --- | --- |
| Directory | `memscribe-learned-<slug>`, lowercase kebab-case, unique inside `skillsRoot`. |
| `SKILL.md` | Required. Strict frontmatter: `name`, `display_name`, `description`. |
| `references/` | Optional source material used by the skill. |
| `templates/` | Optional reusable outputs or prompts. |
| `scripts/` | Optional executable validators/helpers. |
| `assets/` | Optional examples, fixtures, static assets, or schemas. |
| `.memscribe-skill.json` | Optional metadata file. If present, its `name` must match the directory. |

## Learning Loop

Definition: a learning loop converts repeated workflow memories into validated
skill packages, compresses the source memories into short routing cues, and
feeds future prompt builds with learned-skill routes plus recent skill outcomes.

```
prompt-build
  |
  +-- memory full-index recall
  |
  +-- learned skill recall + recent usage signals
  |
  v
main model prompt

turn-end(done)
  |
  v
memory extraction
  |
  v
LearningLoopGate
  | no
  +----> skip
  |
  | yes
  v
SkillCheckpoint
  |
  v
SkillEvolutionRunner writes staging only
  |
  v
validate staged skill + coordination packet
  |
  +-- valid ----> finalize skill -> dream compress-memory(topics)
  |
  +-- invalid --> rollback: restore memory + skill store snapshot
```

### Prompt Routing

`createMemScribe({ skillRecall })` lets the host or `@memscribe/skills` provide
a learned-skill catalog during prompt build.

| Hook | Behavior |
| --- | --- |
| `onPromptBuild(sessionId)` | Returns normal memory recall plus `skillPreludePrompt` when skill recall is configured. |
| `context()` | Uses the same prompt-build path as `onPromptBuild()`. |
| `recordSkillUsage(record)` | Stores host-observed `selected`, `completed`, `failed`, or `missed` skill usage signals. |
| `getSkillUsageRecords(sessionId?)` | Returns usage signals for prompt recall and skill evolution. |

The skill prelude is routing metadata only. It names learned skills, trigger
hints, paths, and recent outcomes. It does not execute skills and does not copy
skill procedure steps into memory.

MemScribe does not execute skills. The host owns skill loading, execution
policy, runtime permissions, and any tool calls made by a selected skill.

### Gate

`LearningLoopGate` is deterministic and must run before any model-driven skill
evolution.

| Input | Rule |
| --- | --- |
| `source` | Must be `local`; non-local sources skip. |
| `enabled` | Global MemScribe switch. |
| `skillLearningEnabled` | Per-loop skill-learning switch. |
| `doneTurns` | Must meet `minDoneTurns`. |
| `turnsSinceLastSkillEvolution` | Must meet `cooldownTurns`. |
| `toolCalls` | Must meet `minToolCalls`. |
| extraction result | Must be `Completed`; skipped or failed extraction returns `extraction-not-completed` and does not run skill evolution. |

Gate failure returns a skipped result. It does not call the runner.

When the host does not override counters, the SDK counts tool calls from
captured `ExtractionMessage.toolCalls` and tracks the last skill-evolution turn
per session.

### Runner

`SkillEvolutionRunner` is the only model-driven skill evolution step. It receives
a packet and writes only through skill tools bound to a checkpoint staging area.

Expected input:

| Field | Meaning |
| --- | --- |
| `sessionId` | Host session id for audit/learning summary. |
| `reviewPacket` | Recent conversation review packet supplied by the host. |
| `learnedSkillIndex` | Derived list of existing learned skills. |
| `observedSkillUsages` | Host-observed learned skill usage signals. |
| `toolTrajectory` | Host-provided tool trajectory facts. |
| `artifactPaths` | Candidate files produced during the reviewed work. |
| `qualitySignals` | Durable quality signals, such as success/failure outcomes. |
| `tools` | Skill staging tools only. |

Expected tools:

| Tool | Rule |
| --- | --- |
| `skill_list` | Read-only staged skill manifest. |
| `skill_read` | Read one staged skill package file. |
| `skill_write` | Write one staged skill package file. |
| `skill_learn_decide` | Emit the final coordination packet exactly once. |

The runner must not write live files, archive memories, or mutate `MEMORY.md`.
When it returns `memoryAction=compress-memory`, `createMemScribe` routes that
coordination to dream as a forced pass, so memory keeps only a short skill cue.

### Coordination Packet

The packet connects memory and skill work. It is a runtime directive, not a new
frontmatter field.

```ts
interface SkillEvolutionCoordinationPacket {
  decision: "create" | "update" | "noop";
  targetSkill: string | null;
  why: string;
  memoryAction: "compress-memory" | "noop";
  memoryTopics: string[];
  supportingFiles: string[];
}
```

Mismatch rules:

| Case | Result |
| --- | --- |
| `decision=noop` with any `targetSkill`, `memoryTopics`, or `supportingFiles` | Fail. |
| `decision=create/update` without `targetSkill` | Fail. |
| `decision=create/update` without `memoryAction=compress-memory` | Fail. |
| `decision=create/update` with empty `memoryTopics` | Fail. |
| Finalized changed skill does not equal `targetSkill` | Fail and rollback. |
| `decision=noop` but files changed | Fail and rollback. |

## Finalize and Rollback

Finalization is the only path from staging to live.

| Step | Rule |
| --- | --- |
| Checkpoint | Snapshot `skillsRoot` and copy it to a staging root before runner execution. |
| Staging | Runner writes only staged files through `skill_write`. |
| Validate | Validate directory name, strict frontmatter, required sections, numbered procedure, supporting files, and public naming. |
| Finalize | Verify the finalized skill tree did not change after checkpoint, validate changed staged skill directories, then publish the changed learned skill. |
| Rollback | On any validation, write, audit, or coordination failure, restore the snapshot and return `Failed`. |

No partial success is allowed. No heuristic repair is allowed. A failed run should
leave the store exactly as it was at checkpoint time.

## Test Matrix

| Area | Test file | Acceptance |
| --- | --- | --- |
| Skills store validation | `packages/skills/src/learned-skill.test.ts` | Rejects missing `SKILL.md`, invalid id, public naming leaks, path traversal, sensitive supporting files, and malformed sections. |
| Skill prompt recall | `packages/skills/src/learned-skill.test.ts` and `packages/sdk/src/index.test.ts` | Learned-skill routes and recent usage signals appear in prompt build. |
| Checkpoint rollback | `packages/skills/src/learned-skill.test.ts` | Snapshot rollback restores the previous live skill tree after finalize. |
| Coordination mismatch | `packages/sdk/src/skill-evolution-agent.test.ts` | Invalid `memoryAction`, noop/file-change mismatch, multi-skill changes, or target mismatch fail and rollback. |
| Learning-loop gate | `packages/sdk/src/learning-loop.test.ts` | Gate skips non-local source, disabled flags, below-threshold turns/tools, or cooldown. |
| Integrated turn-end hook | `packages/sdk/src/index.test.ts` | `createMemScribe({ learningLoop })` can run extraction -> skill evolution -> forced dream coordination when the host opts in. |
| Opt-in adapter assembly | `packages/adapters/src/host-memscribe.test.ts` | `createHostMemScribe({ toolCompletion, learnedSkills })` runs extraction -> skill evolution -> dream -> next prompt recall through the same adapter assembly path. |
| Runnable learning-loop example | `examples/learning-loop/run.mjs` | Fake and real modes both exercise `createHostMemScribe({ toolCompletion, learnedSkills })` through the same adapter assembly path. |
| Dream coordination | `packages/sdk/src/learning-loop.test.ts` | `compress-memory` keeps only a short routing cue in memory and never copies skill execution steps into memory. |
| Runner isolation | `packages/sdk/src/skill-evolution-agent.test.ts` | Runner can write staging only; direct live skill or memory mutations are rejected. |
| Branch/PR hygiene | repo-level docs or CI lint | Local branch work only; no direct `main`, no direct remote push, future GitHub delivery is branch + PR. |

Minimum command set after implementation:

```sh
pnpm build
pnpm test
```

Optional focused commands:

```sh
pnpm --filter @memscribe/skills test
pnpm --filter @memscribe/sdk test -- learning-loop
pnpm --filter @memscribe/sdk test -- skill-evolution-agent
pnpm --filter @memscribe/adapters test
pnpm --filter @memscribe/examples smoke
```

## Branch and PR Rules

| Rule | Acceptance |
| --- | --- |
| Work locally on a feature branch | Do not implement directly on `main`. |
| Do not push directly | Future GitHub delivery must use branch + PR. |
| Keep public names clean | No old names, internal host names, or experiment labels in public docs/API/tests. |
| Keep external provenance out of the mainline | Provenance notes belong in private research or references, not runtime docs. |
| Let failures surface | Validation errors fail the run; no fallback package, no silent downgrade, no best-effort finalize. |

## Open Questions Before Code

| Question | Recommended answer |
| --- | --- |
| Should skills live under the memory root? | No. Use a dedicated `skillsRoot` outside the memory scan path. |
| Should MemScribe execute skills? | No. Hosts execute or load skills; MemScribe stores and validates them. |
| Should memory frontmatter gain skill fields? | No. Use runtime `CoordinationPacket` and short memory body cues. |
| Should failed skill evolution still compress memory? | No. Compression only happens after skill finalize succeeds. |
