# MemFlywheel

Turn every Agent run into a smarter start for the next one.

MemFlywheel is a file-native long-term memory and skill-learning layer for AI Agent Harnesses.

It turns an Agent's preference understanding, tool-call trajectory, project conventions, failure lessons, and repeated workflows into auditable, portable, evolvable Markdown memories and learned skills.

Memory is no longer a temporary fragment inside the context window, nor hidden state inside a black-box service. It becomes an engineering asset that can be inspected, diffed, archived, and reused.

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/01-overview.png
Image prompt:
A technical hand-drawn whiteboard-style architecture diagram on a light paper background, black sketch lines, with a few blue and green accents. Put "MemFlywheel" in the center. On the left, "Host Agent / Harness" with labels showing model, auth, tools, and lifecycle are owned by the host. On the right, file-native storage including MEMORY.md, typed markdown memories, .memflywheel/sources, and learned skills. Use circular arrows to show the flywheel loop: memory -> recall -> skill -> dream -> memory. Clean engineering feel, no 3D, no gradients, no people.
-->

## Why MemFlywheel

Many existing Agent memory systems start from "memory storage and recall": extracting conversations, preferences, or knowledge into a memory store, vector database, knowledge graph, or framework store, then reusing them later through search, retrieval, or context injection.

MemFlywheel takes an agent-native-first approach and focuses on a layer closer to the execution site inside an Agent Harness: it does not only preserve "what was remembered", but also captures "why this worked", "where it failed", and "which procedures are worth reusing", then turns that experience into auditable, portable, evolvable file assets.

| Dimension | Common memory systems | MemFlywheel |
|---|---|---|
| Focus | Memory storage, search recall, context injection | Execution experience capture, evidence traceability, skill evolution |
| Memory objects | Conversations, preferences, knowledge snippets | Preference understanding, project conventions, tool trajectories, failure lessons, repeated workflows |
| Storage shape | API, vector database, knowledge graph, framework store | Markdown memories, `MEMORY.md`, `.memflywheel/sources`, learned skills |
| Recall path | Retrieve relevant snippets and inject them into the prompt | Pre-retrieval -> index cues -> memory body -> source trace |
| Learning loop | Usually focused on whether memory can be recalled | Repeated workflows become learned skills and feed back into long-term memory consolidation |
| Engineering governance | Depends on service or framework-internal state | Files are readable, diffable, archivable, and indexes are rebuildable |

MemFlywheel also does not take over the model, tools, or main Agent execution. Model service, authentication, business tools, and task decisions remain owned by the host Agent / Harness. MemFlywheel only plugs into lifecycle points such as prompt-build, turn-end, session-end, and idle, and is responsible for long-term memory, skill learning, and file-based governance.

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

## Core Flow

```text
Any Host Agent / Harness
  Pi / Hermes / OpenClaw / OpenCode / custom harness
  owns model / auth / tools / policy / business execution
        |
        | plug in through SDK hooks / host adapter
        v
MemFlywheel lifecycle hooks
        |
        +-- prompt-build
        |     +-- scan memory files and build MEMORY.md index
        |     +-- if index is small: inject full index cues
        |     +-- if index is large: run index-layer pre-retrieval
        |     |     +-- embedding + BM25 + RRF over MEMORY.md lines
        |     |     +-- inject top relevant index cues
        |     +-- inject recall rules
        |     +-- optional learned-skill routes
        |     |
        |     +-- Main Agent decides what to read
        |           selected/full index cue -> memory .md body -> .memflywheel/sources trace
        |
        +-- turn-end / agent-end / session-end
        |     +-- collect new transcript + tool trajectory
        |     +-- write cleaned trace to .memflywheel/sources
        |     +-- extraction subagent decides create / update / merge / archive / noop
        |     +-- write memory files and rebuild MEMORY.md
        |
        +-- skill learning gate
        |     +-- after successful extraction, check turns / tool calls / cooldown
        |     +-- evolve learned skills: create / update / merge / noop
        |     +-- if skill changed, force dream to compress related memory into skill cues
        |
        +-- idle / forced dream
        |     +-- deterministic cleanup
        |     +-- optional dream subagent consolidation
        |     +-- dedupe / compress / archive / retag
        |     +-- rebuild MEMORY.md
        |
        v
Next turn / next session
  gets cleaner index cues + richer memories + reusable learned skills
        |
        +---------------------------------------------------------------+
        |                                                               |
        +---------------- back to prompt-build --------------------------+
```

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/02-lifecycle.png
Image prompt:
A technical hand-drawn whiteboard-style flowchart showing the MemFlywheel lifecycle loop. Nodes include prompt-build, main agent turn, turn-end extraction, skill evolution gate, dream consolidation, and next prompt-build. Use hand-drawn rectangular boxes and arrows forming a loop. Add side labels for typed memory files, MEMORY.md, and learned skills. Clean, clear, engineering diagram, light background.
-->

## File-Native Storage

The source of truth in MemFlywheel is the Markdown files under the memory root. `MEMORY.md` is only an index rebuilt from those files.

```text
memory-root/
  MEMORY.md

  identity/*.md
  preference/*.md
  style/*.md
  workflow/*.md
  context/*.md
  ambient/*.md

  .memflywheel/
    sources/*.jsonl
    index/*

skills-root/
  memflywheel-learned-*/SKILL.md
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

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/03-file-layout.png
Image prompt:
A technical hand-drawn file-tree diagram showing memory-root and skills-root. Under memory-root show MEMORY.md, identity, preference, style, workflow, context, ambient, .memflywheel/sources, and .memflywheel/index. Under skills-root show memflywheel-learned-*/SKILL.md. Use folder and document icons, whiteboard sketch style, clean and clear, with subtle color accents for MEMORY.md, sources, and learned skills.
-->

## Progressive Recall and Index-Layer Pre-Retrieval

MemFlywheel does not put every memory body into the prompt. It first injects index cues and lets the main business Agent decide whether to read complete memory files.

```text
User query / current task
        |
        v
MEMORY.md index records
        |
        +-- small index -> inject full MEMORY.md cues
        |
        +-- large index -> embedding + BM25 + RRF over index lines
                         -> inject topN relevant paths
        |
        v
Main Agent reads selected *.md files
        |
        v
If body is not enough, read .memflywheel/sources/*.jsonl line ranges
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
Layer 1: MEMORY.md index cues
        |
Layer 2: selected memory Markdown body
        |
Layer 3: source trace JSONL line ranges
```

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/04-progressive-recall.png
Image prompt:
A technical hand-drawn layered diagram titled Progressive Recall. Three layers from top to bottom: MEMORY.md index cues, selected memory .md body, .memflywheel/sources JSONL traces. On the left, user query enters index pre-retrieval, passes through embedding + BM25 + RRF, and selects top paths only. On the right, label "host agent uses its own Read/Grep tools". Light background, black lines, a few blue and green accents.
-->

## Learning Flywheel

MemFlywheel does not only preserve factual memory. It also turns repeatedly appearing executable procedures into learned skills. After one execution finishes, memory extraction first captures facts and trajectories, then skill evolution distills stable procedures into skills. When a skill changes, it triggers dream coordination in the opposite direction, compressing redundant procedural detail into memory cues that point to the skill. At the start of the next task, the main Agent sees both related memory and skill routes; after using them, it produces new trajectories that enter the next round of extraction, learning, and consolidation, creating the flywheel effect.

```text
Real task execution
        |
        v
Conversation + tool trajectory
        |
        v
memory extraction
        |
        +-- facts / preferences / project rules
        +-- failure lessons / workflow evidence
        |
        v
skill learning gate
        |
        v
skill evolution agent
        |
        +-- create / update / merge / noop learned skills
        |
        v
memflywheel-learned-*/SKILL.md
        |
        v
dream coordination
        |
        +-- compress redundant workflow memory
        +-- leave skill cues in related memories
        |
        v
next prompt-build
        |
        +-- memory index cues
        +-- learned-skill routes
        |
        v
Main Agent reuses memory + skill
        |
        v
better execution, new evidence
        |
        +--------------------------------+
        |                                |
        +------ back to extraction -------+
```

<!--
IMAGE_PLACEHOLDER: docs/assets/readme/05-skill-flywheel.png
Image prompt:
A technical hand-drawn flywheel diagram. Circular arrows include Memory, Recall, Repeated Workflow, Learned Skill, Dream Compression, and Better Memory. Put MemFlywheel in the center. Add a SKILL.md file card and several Markdown memory file cards around it. Show that memory and skills reinforce each other. Whiteboard sketch style, clean, not a marketing poster.
-->

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
