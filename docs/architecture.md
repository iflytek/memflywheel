# Architecture

MemScribe is a file-backed long-term memory kernel. It has four moving parts — **storage**,
**recall**, **extraction**, and **dream** — plus cross-cutting concerns (privacy, locking,
atomic writes, audit) that every write path shares.

The core (`@memscribe/core`) is pure: it touches only the filesystem and never calls an LLM.
The two model-driven steps (extraction, dream) are deterministic in the core and reach the
model only through injected function contracts. Hosts wire those contracts and the turn
lifecycle through `@memscribe/sdk` and `@memscribe/adapters`, or expose a subset over
`@memscribe/mcp-server`.

## Memory root and layout

The store is a single directory tree. The root is resolved with this precedence:

1. An explicit `root` passed by the caller.
2. The `MEMSCRIBE_HOME` environment variable.
3. `<os-data-dir>/memscribe/memory`, where the OS data dir is `APPDATA` on Windows,
   `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` (or `~/.local/share`)
   on Linux.

```
<memory-root>/
├── MEMORY.md            # derived index (rebuildable; never hand-edited)
├── .memory-task-lock    # per-root write lock
├── .last-extraction     # extraction timestamp
├── .consolidate-lock    # dream lock
├── .audit.log           # append-only audit log
├── identity/
├── preference/
├── style/
├── workflow/
├── context/
└── ambient/
```

Each memory lives at `<type>/<filename>.md`. Reserved names
(`MEMORY.md`, `.memory-task-lock`, `.last-extraction`, `.consolidate-lock`, `.audit.log`)
are skipped during scans and rejected as memory filenames.

## Storage

A memory file is a YAML frontmatter block followed by a free-text Markdown body:

```markdown
---
name: 用户称呼
description: 用户偏好的称呼
type: identity
---

叫用户小钟。
```

The Markdown files are the source of truth. Frontmatter parsing is hand-rolled: only the
first `FRONTMATTER_READ_BYTES` (2048) are read for a header scan, the block must close
within `MAX_FRONTMATTER_LINES`, and `name` + a valid `type` are required or the entry is
ignored. See [`memory-schema.md`](memory-schema.md).

Writes go through `writeMemoryDocument` / `deleteMemoryDocument` / `archiveMemoryDocument`
on a `StorageContext` (`{ root, audit }`). Every write is:

- **Privacy-filtered** first — `<private>…</private>` spans become `[REDACTED]`. The
  optional `refuseSecrets` gate can also refuse obvious secrets (see
  [`extraction.md`](extraction.md) and the privacy notes below).
- **Atomic** — written to a temp file and `rename`d into place.
- **Audited** — appended to `.audit.log`.

`scanMemoryFiles(root)` walks the tree, parses each header, sorts entries by `mtime`
descending, and caps the result at `MAX_SCAN_ENTRIES` (200). Its output is the
`MemoryEntry[]` that drives both the index and recall.

## The derived index (`MEMORY.md`)

`MEMORY.md` is regenerated from the scanned entries; it is never authored by hand or by the
model. Each entry becomes one line:

```
- [<name>](<type>/<file>.md) - <description> (type: <type>, path: <type>/<file>.md)
```

`syncMemoryIndex(root, entries)` rewrites the file. Before injection the content is passed
through `truncateIndex` (≤ `INDEX_MAX_LINES` = 200 lines and ≤ `INDEX_MAX_BYTES` = 25 000
UTF-8 bytes, with a truncation marker appended when cut) and `applyAgingHints` (per-type
aging — see [`memory-schema.md`](memory-schema.md)).

## Recall

Recall is full-index injection, no retrieval. `buildContext({ root, enabled })` runs a
deterministic pipeline — scan → sync index → read → truncate → apply aging hints — and
returns two strings:

- `systemPrompt`: stable memory rules (a cache-friendly prefix).
- `preludePrompt`: the whole index wrapped in `<system-reminder>`, re-injected each turn.

The main model reads the index and decides on its own whether any entry is relevant and
whether to `Read` a body. There is no scoring, ranking, or embedding step anywhere. See
[`recall.md`](recall.md).

## Extraction

After a turn, the host may trigger extraction. The core owns the whole mechanism — lock,
cursor, message-window selection, relocation, index sync, and the validated ordinary file tools —
and calls the host's injected `ExtractionAgentRunner` for the one model-driven step. The
subagent calls `glob` / `grep` / `read` and then writes through
`write` / `edit` / `bash`; those tool calls are the file changes.
`runExtractionSession` acquires the write lock, cleans and windows the messages against a
per-session cursor, lets the subagent drive the tools, relocates any stray root-level files
into typed directories, re-syncs the index, and advances the cursor only on success. See
[`extraction.md`](extraction.md).

## Dream (consolidation)

Dream is an idle/scheduled consolidation pass, not a summarizer. It runs in two phases under
the consolidation lock, with the same atomic-write and audit guarantees. First a
deterministic, LLM-free structural pre-pass cleans the state (delete identical-body
duplicates, relocate path/type-mismatched files). Then the host's injected `DreamAgentRunner`
— a tool-calling consolidation subagent that runs the same agent loop as extraction — works
over the cleaned state: it reads full memory bodies and performs semantic consolidation
(merges, compression, type re-judgement) by calling the ordinary file tools directly
(`glob` / `grep` / `read` / `write` / `edit` /
`bash`). There are no operations
returned anymore — the tool calls are the changes. `shouldRunDream` gates the pass on a
minimum elapsed time (`DREAM_DEFAULT_MIN_HOURS` = 24) or a minimum session count
(`DREAM_DEFAULT_MIN_SESSIONS` = 5).

## Cross-cutting concerns

- **Privacy.** `redactPrivateSpans` softens `<private>…</private>` to `[REDACTED]`.
  The hard-secret scan (`scanSecrets` / `enforceWritePrivacy`) is controlled by the
  `refuseSecrets` gate: MCP enables it for `write`; core/SDK/CLI leave it off by
  default. When enabled, obvious secrets (SSH/PEM keys, API-key and token prefixes,
  bearer/JWT tokens, `password:`/`cookie:` assignments) are refused with masked findings.
- **Locking.** A per-root file lock (`.memory-task-lock`) serializes writers, with stale
  detection (`LOCK_TIMEOUT_MS`) for crashed holders. `withLock` wraps a critical section.
- **Atomic writes.** `atomicWriteFile` does temp-file + `rename`; `appendFileLine` backs the
  audit log.
- **Audit.** `.audit.log` is an append-only record of writes/deletes/archives, produced by
  `createAuditLogger` (or a no-op via `createNullAuditLogger`).

## Package boundaries

```
@memscribe/core      filesystem only, no LLM, no host coupling
   ▲
   │ ExtractionAgentRunner / DreamAgentRunner contracts + lifecycle calls
   │
@memscribe/sdk       wires injection points + turn lifecycle
   ▲
   │
@memscribe/adapters  per-host lifecycle mapping
@memscribe/mcp-server context / save tools over MCP
@memscribe/cli       context / list / read / write / doctor / dream / rebuild-index
```

See [`integrations.md`](integrations.md) for the adapter and MCP surfaces.
