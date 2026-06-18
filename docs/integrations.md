# Integrations

MemScribe is meant to be embedded in an existing agent runtime, not run as a standalone
product. Two integration surfaces sit on top of `@memscribe/core`: **host adapters** (native
lifecycle wiring) and the **MCP server** (a portable tool surface). Both ultimately call the
same core functions; the difference is how the host's turn lifecycle reaches them.

> The core is the implemented kernel. The SDK, CLI, MCP server, and adapter packages are the
> integration layer around it; their surfaces are described here.

## The lifecycle MemScribe expects

Every integration maps three host events onto the core:

| Host event | Core call | Effect |
|---|---|---|
| Turn start | `buildContext({ root, enabled })` | Produce the two injection segments (system rules + `<system-reminder>` index prelude). |
| Turn end (after-turn) | `runExtractionSession({ ctx, agent, messages, sessionId, cursorStore })` | Window recent messages; the extraction subagent writes memory files directly via the tools; sync index. |
| Idle / scheduled | `shouldRunDream(...)` → `runDreamSession({ ctx, runner })` | Deterministic structural pre-pass, then the consolidation subagent (merge/compress/retire via tools), under the dream lock. |

The two model-driven functions — the `ExtractionAgentRunner` and the `DreamAgentRunner` — can be the built-in
defaults or host-supplied. The core provides everything deterministic: locking, cursors,
atomic writes, index sync, relocation, privacy, audit. See [`recall.md`](recall.md),
[`extraction.md`](extraction.md), and [`architecture.md`](architecture.md).

### The default extraction and dream subagents

Both model-driven steps ship with a working default, so a host does not have to author the
"what is worth remembering" prompt or wire the loop:

- The core owns a curated default extraction **system prompt** plus the **memory tools**
  (`createMemoryTools()`: `memory_list` / `memory_search` / `memory_read` /
  `memory_save` / `memory_update` / `memory_archive`),
  and ships a default consolidation **system prompt** for dream too. The core makes no network call.
- The SDK assembles them into running functions via
  `createExtractionAgentRunner({ toolCompletion })` and `createDreamAgentRunner({ toolCompletion })`.
  A single `toolCompletion` channel — the tool-aware LLM channel — drives both subagents. Each
  runner drives a tool-calling subagent that reads full memory bodies and writes the memory
  files itself through the tools.
- The SDK also ships `createToolCompletion()`, a built-in tool completion built on Node's
  global `fetch` that targets an OpenAI-compatible `/chat/completions` endpoint with a `tools`
  array, reading provider / endpoint / key / model from the environment (`MEMSCRIBE_LLM_*`).
  With one API key, extraction runs out of the box. An adapter wraps its host's own LLM channel
  into a `ToolCompletion` instead.

## SDK (`@memscribe/sdk`)

The SDK is the glue that wires the injection points and the turn lifecycle so an adapter does
not re-implement them per host. It exposes lifecycle hooks (turn-start recall, after-turn
extraction, idle dream) and carries the host-supplied `ExtractionAgentRunner` / `DreamAgentRunner` and
`CursorStore` through to the core. It adds no LLM behavior of its own — it only schedules the
core's deterministic steps and forwards the model-driven calls to the host's functions.

## Adapters (`@memscribe/adapters`)

An adapter translates one host's concrete lifecycle into the three events above. Targeted
hosts:

- Hermes
- OpenCode
- OpenClaw
- Pi
- Codex
- Claude Code

Each adapter's job is narrow: hook the host's turn-start to inject the two recall segments,
hook the host's turn-completion to trigger extraction with that host's message format mapped
to `ExtractionMessage[]`, and hook an idle/scheduled signal to trigger dream. The
host-specific concerns (where the system prompt and prelude are placed, how messages and
session ids are read, how the host's LLM channel is wrapped into a `ToolCompletion` for the default
extraction/dream subagents) live in the adapter; the memory semantics stay in the core. `connect`
installs the host-side wiring and round-trip-verifies it from disk.

Runnable minimal integrations live under [`../examples/`](../examples/) — one per targeted
host (OpenClaw, Hermes, Pi) — showing the full path: wrap the host LLM into a `ToolCompletion`,
build the default extraction and dream subagents, mount the lifecycle, and install + verify the wiring.

## MCP server (`@memscribe/mcp-server`)

For hosts that speak MCP, MemScribe exposes a deliberately minimal tool surface. There is **no
search tool**, because there is no lexical retrieval.

| Tool | Maps to | Purpose |
|---|---|---|
| `memory_context` | `buildContext` | Return the full-index recall prelude for the current turn. |
| `memory_read` | `readMemoryDocument` | Read one memory body by its relative path. |
| `memory_save` | `writeMemoryDocument` (privacy + atomic + audit) | Explicitly save a memory. |

Inspection and maintenance commands (`doctor`, `dream`, `rebuild-index`) are intentionally **not**
MCP tools — they live in the CLI.

## CLI (`@memscribe/cli`)

The CLI is for operators and scripts working directly against a memory root:

| Command | Purpose |
|---|---|
| `context` | Print the recall segments (rules + `<system-reminder>` index) for inspection. |
| `list` | List scanned entries. |
| `read` | Print one memory body. |
| `write` | Write a memory (runs the same privacy/atomic/audit path). |
| `doctor` | Report health findings (missing/invalid frontmatter, path/type mismatch, duplicates). |
| `dream` | Run a consolidation pass. |
| `rebuild-index` | Rescan and rewrite `MEMORY.md` from the files on disk. |

## Choosing a surface

- **Native host runtime** → use the SDK plus the matching adapter; you supply the `ExtractionAgentRunner`
  and `DreamAgentRunner`.
- **Any MCP-capable host** → run the MCP server and expose `memory_context` / `memory_read` /
  `memory_save`; run `doctor` / `dream` / `rebuild-index` out of band via the CLI.
- **Scripts and operations** → use the CLI directly against a memory root.
