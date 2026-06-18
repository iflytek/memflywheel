# MemScribe

A clean, minimal, file-backed long-term memory subsystem for LLM agents. MemScribe packages a
file-native long-term memory design — a single file-backed store, full-index recall, and an
LLM-driven extraction and consolidation flow — as a dependency-free TypeScript library with
adapter and MCP entry points. It ships a high-quality **default extractor** so that giving it
one API key is enough to start writing memory, and direct integrations for OpenClaw, Hermes,
and Pi.

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
  memory tools (`memory_list` / `memory_search` / `memory_read` / `memory_save` /
  `memory_update` / `memory_archive`) the
  extraction subagent drives. The core stays mechanical — it holds the prompt string and the
  write tools but *never* calls an LLM; the SDK's
  `createExtractionAgentRunner({ toolCompletion })` factory and a built-in fetch-based tool
  completion assemble the default prompt, the model loop, and the tools into a ready-to-run
  subagent that writes memory files itself. Dream consolidation is the same kind of
  tool-calling subagent, shipped via `createDreamAgentRunner({ toolCompletion })`.
- **LLM steps stay pluggable.** The core never calls an LLM; the model-driven steps enter
  only through injected `ExtractionAgentRunner` and `DreamAgentRunner` contracts — both
  tool-calling subagents over a single `toolCompletion` channel. Supply your own, or use the
  built-in defaults.
- **Adapter- and MCP-first.** MemScribe is meant to be wired into an existing agent runtime
  via host lifecycle adapters or exposed over MCP, not to be a standalone product.

## What MemScribe is not

- **No embeddings / vectors / similarity search.** Recall never computes a distance.
- **No top-k, no scoring, no BM25, no entity index.** The index is injected whole; the
  model self-selects.
- **No scope.** MemScribe is a single global store. There is no user / project / workspace
  tiering.
- **No extra frontmatter fields.** Only `name` / `description` / `type` (plus minimal
  `created_at` / `updated_at`). No `origin` / `source_ref` / `confidence` / `status` /
  `agent` / `project` / `session`.
- **No standalone `search` tool.** The MCP surface exposes context / read / save only;
  inspection and maintenance live in the CLI.

## Packages

| Package | Role |
|---|---|
| `@memscribe/core` | Memory kernel: storage, derived index, recall, extraction, dream, privacy, locking, atomic writes, audit. No LLM, no host coupling. |
| `@memscribe/sdk` | Lifecycle hooks and wiring for the `ExtractionAgentRunner` / `DreamAgentRunner` injection points, the `createExtractionAgentRunner` / `createDreamAgentRunner` factories, and a built-in fetch-based tool completion (OpenAI-compatible). |
| `@memscribe/cli` | `context` / `list` / `read` / `write` / `doctor` / `dream` / `rebuild-index`. |
| `@memscribe/mcp-server` | MCP tools: `memory_context` / `memory_read` / `memory_save`. |
| `@memscribe/adapters` | Host lifecycle mappings for Hermes, OpenCode, OpenClaw, Pi, Codex, and Claude Code. |

## Default extraction subagent (give it one API key)

MemScribe does not leave the "what is worth remembering" judgment as an empty injection point.
It ships that judgment as the default extraction subagent: a curated extraction system prompt
plus the memory write tools the subagent calls to write files itself. The core owns both as
pure values (a prompt string and the tool handlers) and never makes a network call. The SDK
turns them into a running tool-calling subagent:

```ts
import { createMemScribe } from "@memscribe/sdk";
import {
  createExtractionAgentRunner,
  createDreamAgentRunner,
  createToolCompletion,
} from "@memscribe/sdk";

// `createToolCompletion()` is the tool-aware LLM channel: it reads provider /
// endpoint / key / model from the env (MEMSCRIBE_LLM_*) and calls an
// OpenAI-compatible /chat/completions with a tools array. One channel drives
// BOTH subagents — extraction and dream consolidation.
const toolCompletion = createToolCompletion();
const scribe = createMemScribe({
  agent: createExtractionAgentRunner({ toolCompletion }),
  dreamRunner: createDreamAgentRunner({ toolCompletion }),
});
```

Supply your own `toolCompletion` to route through a host's existing LLM channel, or supply a
fully custom `ExtractionAgentRunner` / `DreamAgentRunner` to replace the defaults entirely.

## Direct integrations

The adapter package wires MemScribe into a host runtime: it wraps the host's own tool-calling
LLM channel into a `toolCompletion`, feeds it to the default extraction subagent, mounts the
full lifecycle (session start / prompt build / turn end / agent end / idle), and can install
and round-trip-verify the host-side wiring. Runnable minimal integrations live under
[`examples/`](examples/) for OpenClaw, Hermes, and Pi.

## Supported hosts

The adapter package maps each host's turn lifecycle (turn-start recall injection,
after-turn extraction trigger, idle/scheduled dream) onto the core. Targeted hosts:
Hermes, OpenCode, OpenClaw, Pi, Codex, Claude Code.

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
- [`docs/integrations.md`](docs/integrations.md) — adapters and MCP.

## Develop

```sh
pnpm install
pnpm build
pnpm test
```
