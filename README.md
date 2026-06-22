# MemScribe

A clean, minimal, file-backed long-term memory subsystem for LLM agents. MemScribe packages a
file-native long-term memory design — a single file-backed store, full-index recall, and an
LLM-driven extraction and consolidation flow — as a dependency-free TypeScript library with
SDK and host adapter entry points. It ships a high-quality **default extractor** so that giving it
one API key is enough to start writing memory, plus direct integrations for selected agent
hosts.

## What MemScribe is

- **File-backed.** Each memory is a Markdown body plus a small YAML frontmatter
  (`name` / `description` / `type`). The Markdown files are the source of truth.
  `MEMORY.md` is a derived, rebuildable index — never hand-edited.
- **Full-index recall, no retrieval.** Every turn, the *whole* index is injected and the
  main model decides for itself whether a given memory is relevant and whether to `Read`
  its body. There is no per-turn search.
- **Two-segment injection.** Stable memory rules go into the system prompt (cache-friendly
  prefix); the full `MEMORY.md` index goes into a `<system-reminder>` prelude that is
  re-injected each turn.
- **Six memory types.** `identity` / `preference` / `style` / `workflow` / `context` /
  `ambient`. `context` and `ambient` age after 30 days
  (a "suggest verification" hint is appended in the index); the rest are permanent.
- **Batteries-included extraction.** MemScribe ships a high-quality default extraction prompt
  (what is worth remembering, what is forbidden, the six types, privacy redaction) plus the
  ordinary file tools (`glob` / `grep` / `read` / `write` /
  `edit` / `bash`) the
  extraction subagent drives. The core stays mechanical — it holds the prompt string and the
  write tools but *never* calls an LLM; the SDK's
  `createExtractionAgentRunner({ model })` factory consumes a provider-neutral canonical
  model channel and assembles the default prompt, the model loop, and the tools into a
  ready-to-run subagent that writes memory files itself. Dream consolidation is the same
  kind of tool-calling subagent, shipped via `createDreamAgentRunner({ model })`.
- **LLM steps stay pluggable.** The core never calls an LLM; the model-driven steps enter
  only through injected `ExtractionAgentRunner` and `DreamAgentRunner` contracts — both
  tool-calling subagents over a single canonical model channel. Supply a host-owned model
  port, or use one of the provider mappers in `@memscribe/model`.
- **Host-adapter-first.** MemScribe is meant to be wired into an existing agent runtime
  through SDK lifecycle hooks and host adapters, not to be a standalone product.
- **Skills are host-executed.** MemScribe can store, validate, route, and evolve learned
  skill packages, but the host owns skill loading, policy, and execution.

## What MemScribe is not

- **No embeddings / vectors / similarity search.** Recall never computes a distance.
- **No top-k, no scoring, no BM25, no entity index.** The index is injected whole; the
  model self-selects.
- **No scope.** MemScribe is a single global store. There is no user / project / workspace
  tiering.
- **No extra frontmatter fields.** Only `name` / `description` / `type` (plus minimal
  `created_at` / `updated_at`). No `origin` / `source_ref` / `confidence` / `status` /
  `agent` / `project` / `session`.
- **No MemScribe-specific read/search wrapper.** Recall context is delivered through the
  prompt; the host's own filesystem tools read any selected memory body.
- **No standalone runtime surface.** Learned-skill recall and evolution are enabled only
  through SDK/adapters that explicitly wire the host lifecycle and model channel.

## Packages

| Package | Role |
|---|---|
| `@memscribe/core` | Memory kernel: storage, derived index, recall, extraction, dream, privacy, locking, atomic writes, audit. No LLM, no host coupling. |
| `@memscribe/model` | Provider-neutral tool-calling model protocol plus provider mappers, including OpenAI-compatible Chat Completions. |
| `@memscribe/sdk` | Lifecycle hooks and wiring for the `ExtractionAgentRunner` / `DreamAgentRunner` injection points and the `createExtractionAgentRunner` / `createDreamAgentRunner` factories. |
| `@memscribe/skills` | File-native learned skill store with staging, strict validation, prompt recall, finalize, and rollback. |
| `@memscribe/adapters` | Host lifecycle mappings for selected agent runtimes. |

## Default extraction subagent (give it one API key)

MemScribe does not leave the "what is worth remembering" judgment as an empty injection point.
It ships that judgment as the default extraction subagent: a curated extraction system prompt
plus the ordinary file tools the subagent calls to write files itself. The core owns both as
pure values (a prompt string and the tool handlers) and never makes a network call. The SDK
turns them into a running tool-calling subagent:

```ts
import { createMemScribe } from "@memscribe/sdk";
import {
  createExtractionAgentRunner,
  createDreamAgentRunner,
} from "@memscribe/sdk";
import { createOpenAIChatCompletionsModel } from "@memscribe/model";

// The canonical model reads endpoint / key / model from MEMSCRIBE_LLM_* and maps
// OpenAI-compatible /chat/completions into MemScribe's provider-neutral protocol.
// One channel drives BOTH subagents: extraction and dream consolidation.
const model = createOpenAIChatCompletionsModel();
const scribe = createMemScribe({
  agent: createExtractionAgentRunner({ model }),
  dreamRunner: createDreamAgentRunner({ model }),
});
```

Supply your own `CanonicalModelCompletion` to route through a host's existing model channel,
or supply a fully custom `ExtractionAgentRunner` / `DreamAgentRunner` to replace the defaults
entirely.

## Direct integrations

The adapter package wires MemScribe into a host runtime: it maps the host into a
`HostHarnessPort` with capabilities, lifecycle hooks, telemetry, and a canonical model
channel. `createMemScribeHarnessRuntime({ port })` feeds that model to the default extraction,
dream, and optional skill-learning loops. Runnable minimal integrations live under
[`examples/`](examples/).

## Supported hosts

The adapter package maps each host's turn lifecycle (turn-start recall injection,
after-turn extraction trigger, idle/scheduled dream) onto the core. Targeted
hosts are documented by the adapter package and examples.

## Constraints

- **Zero runtime dependencies.** Node stdlib + TypeScript only. Frontmatter parsing,
  atomic writes, and locking are hand-rolled on `node:fs/promises`, `node:path`,
  `node:crypto`.
- **The core never calls an LLM.**
- TypeScript-first, pure Node, pnpm workspace monorepo. Tests use `node:test` /
  `node:assert`, compiled by `tsc` then run via `node --test`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — storage, recall, extraction, dream.
- [`docs/memory-schema.md`](docs/memory-schema.md) — frontmatter, the six types, aging.
- [`docs/recall.md`](docs/recall.md) — full-index injection and model self-selection.
- [`docs/extraction.md`](docs/extraction.md) — the pluggable extractor and the write path.
- [`docs/skill-learning-loop-walkthrough.md`](docs/skill-learning-loop-walkthrough.md) — current skill learning loop, file-diff coordination, and memory feedback path.

Skill learning is exposed as SDK primitives and opt-in hooks: prompt build can
include learned-skill routes and recent usage signals, and host/adapters can wire
turn end to run extraction, skill evolution, and dream memory compression in
order. It is not enabled for every entry point by default.
- [`docs/integrations.md`](docs/integrations.md) — SDK and host adapters.

## Develop

```sh
pnpm install
pnpm build
pnpm test
```
