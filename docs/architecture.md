# Architecture

MemFlywheel is a file-backed long-term memory kernel. It has four moving parts — **storage**,
**recall**, **extraction**, and **dream** — plus cross-cutting concerns (privacy, locking,
atomic writes, audit) that every write path shares.

The core (`@memflywheel/core`) is pure filesystem logic plus injected ports. It never owns
model transport, provider auth, or provider wire shapes. The two generative steps
(extraction, dream) reach the model only through injected function contracts; optional
index-layer retrieval consumes a host-supplied embedding provider. Hosts wire those
contracts and the turn lifecycle through `@memflywheel/sdk` and `@iflytekopensource/adapters`.

## Memory root and layout

The store is a single directory tree. The root is resolved with this precedence:

1. An explicit `root` passed by the caller.
2. The `MEMFLYWHEEL_HOME` environment variable.
3. `<os-data-dir>/memflywheel/memory`, where the OS data dir is `APPDATA` on Windows,
   `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` (or `~/.local/share`)
   on Linux.

```
<memory-root>/
├── MEMORY.md            # derived index (rebuildable; never hand-edited)
├── .memory-task-lock    # per-root write lock
├── .last-extraction     # extraction timestamp
├── .consolidate-lock    # dream lock
├── .audit.log           # append-only audit log
├── .memflywheel/
│   └── sources/         # cleaned execution traces, addressed by memory body refs
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
retrieval_terms:
  - 用户称呼
  - preferred name
  - address user
---

叫用户小钟。
```

The Markdown files are the source of truth. Frontmatter parsing is hand-rolled: only the
first `FRONTMATTER_READ_BYTES` (2048) are read for a header scan, the block must close
within `MAX_FRONTMATTER_LINES`, and `name` + a valid `type` are required or the entry is
ignored. Supported memory types are `identity`, `preference`, `style`, `workflow`,
`context`, and `ambient`.

The built-in types are common defaults, not a closed product taxonomy. Host developers can
add domain-specific categories if their adapter, scan rules, and prompt contract agree on the
extra directories and `type` values.

| Field             | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `name`            | Short stable label shown in `MEMORY.md` and recall cues                |
| `description`     | One-line routing summary, not the full memory body                     |
| `type`            | Memory category and directory name                                     |
| `retrieval_terms` | Short routing phrases for index-layer retrieval, not a body summary    |
| Markdown body     | The actual memory content                                              |
| `## Sources`      | Optional evidence refs into `.memflywheel/sources/*.jsonl` line ranges |

Writes go through `writeMemoryDocument` / `deleteMemoryDocument` / `archiveMemoryDocument`
on a `StorageContext` (`{ root, audit }`). Every write is:

- **Privacy-filtered** first — `<private>…</private>` spans become `[REDACTED]`. The
  optional `refuseSecrets` gate can also refuse obvious secrets.
- **Atomic** — written to a temp file and `rename`d into place.
- **Audited** — appended to `.audit.log`.

`scanMemoryFiles(root)` walks the tree, parses each header, sorts entries by `mtime`
descending, and caps the result at `MAX_SCAN_ENTRIES` (200) for prompt-sized manifests.
`scanAllMemoryFiles(root)` uses the same scan without that cap for the rebuildable
`MEMORY.md` index and index-layer retrieval corpus.

## The derived index (`MEMORY.md`)

`MEMORY.md` is regenerated from the scanned entries; it is never authored by hand or by the
model. Each entry becomes one line:

```
- [<name>](<type>/<file>.md) - <description> (type: <type>, path: <type>/<file>.md)
```

`syncMemoryIndex(root, entries)` rewrites the file. Before injection the content is passed
through `truncateIndex` (≤ `INDEX_MAX_LINES` = 200 lines and ≤ `INDEX_MAX_BYTES` = 25 000
UTF-8 bytes, with a truncation marker appended when cut) and `applyAgingHints` for
time-sensitive memory types such as `context` and `ambient`.

`retrieval_terms` help find the right index line; they should stay short and grounded in
likely query wording. They are not a second description field and should not copy the memory
body. Source traces are intentionally outside `MEMORY.md`: memory bodies may point to them
through `## Sources`, but source JSONL is never scanned into the recall index.

## Recall

Recall is progressive index injection. `buildContext({ root, enabled, query?, indexRetrieval? })`
runs a deterministic pipeline — scan → sync index → read → truncate → apply aging hints —
and returns two strings:

- `systemPrompt`: stable memory rules (a cache-friendly prefix).
- `preludePrompt`: either the full/truncated index or a hybrid-retrieved subset of index
  lines plus a `MEMORY.md` fallback path, wrapped in `<system-reminder>`.

The main model reads the index and decides on its own whether any entry is relevant and
whether to `Read` a body. Hybrid retrieval, when configured, ranks only index lines with
embedding + BM25 + RRF; memory bodies are not embedded or searched.

## Extraction

After a turn, the host may trigger extraction. The core owns the whole mechanism — lock,
cursor, message-window selection, relocation, index sync, and the validated ordinary file tools —
and calls the host's injected `ExtractionAgentRunner` for the one model-driven step. The
subagent calls `glob` / `grep` / `read` and then writes through
`write` / `edit` / `bash`; those tool calls are the file changes.
`runExtractionSession` acquires the write lock, cleans and windows the messages against a
per-session cursor, appends only the newly processed messages as cleaned JSONL under
`.memflywheel/sources/session-<hash>.jsonl`, lets the subagent drive the tools, and passes the
resulting `sourceRef` into the memory file tools. Cursor context is still visible to the
extraction agent, but is not persisted again. Any memory written through `write` or `edit`
during that extraction pass gets a `## Sources` body section pointing to the JSONL line
range. Multiple memories from the same pass therefore share the same source file and line
range; later passes append new lines and can add more refs. The hidden source directory is
never indexed. The pass then relocates any stray root-level files into typed directories,
re-syncs the index, and advances the cursor only on success.

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

## Learned skills

Learned skills use the same file-native rule: MemFlywheel stores and recalls them, while the
host decides whether to load or execute them. Skill evolution writes into a staged checkpoint
first. Finalize only publishes staged directories after validating package shape, path scope,
and that the target skill tree was not externally changed; failures roll back to the snapshot.

When skill evolution creates, updates, or merges a skill, the coordination result asks dream
to compress redundant workflow memory into a cue pointing at the learned skill. That is the
memory ↔ skill flywheel: repeated procedure details move out of ordinary memory and become a
reusable skill route for future turns.

## Cross-cutting concerns

- **Privacy.** `redactPrivateSpans` softens `<private>…</private>` to `[REDACTED]`.
  The hard-secret scan (`scanSecrets` / `enforceWritePrivacy`) is controlled by the
  `refuseSecrets` gate. Host integrations decide whether to enable it for their write
  path. When enabled, obvious secrets (SSH/PEM keys, API-key and token prefixes,
  bearer/JWT tokens, `password:`/`cookie:` assignments) are refused with masked findings.
- **Locking.** A per-root file lock (`.memory-task-lock`) serializes writers, with stale
  detection (`LOCK_TIMEOUT_MS`) for crashed holders. `withLock` wraps a critical section.
- **Atomic writes.** `atomicWriteFile` does temp-file + `rename`; `appendFileLine` backs the
  audit log.
- **Audit.** `.audit.log` is an append-only record of writes/deletes/archives, produced by
  `createAuditLogger` (or a no-op via `createNullAuditLogger`).

## Package boundaries

Only `@iflytekopensource/adapters` and `@iflytekopensource/hermes` are public npm packages.
The layers below remain private workspace packages; release builds bundle the
runtime pieces into the host-facing packages.

```
@memflywheel/core      filesystem only, no LLM, no host coupling
   ▲
   │ ExtractionAgentRunner / DreamAgentRunner contracts + lifecycle calls
   │
@memflywheel/sdk       wires injection points + turn lifecycle
   ▲
   │
@iflytekopensource/adapters  per-host lifecycle mapping
```

See [`integrations.md`](integrations.md) for the SDK and host adapter surfaces.
