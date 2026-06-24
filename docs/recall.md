# Recall

Recall is how a memory store reaches the model on a given turn. MemFlywheel's answer is
deliberately narrow: **give the model index cues, never pre-load memory bodies.**

## Index-Layer Retrieval

The default path is still full-index injection when the bounded `MEMORY.md` index fits the
prompt budget. When the index is larger and the host supplies an embedding provider,
MemFlywheel can run hybrid retrieval over `MEMORY.md` index lines only:

```
MEMORY.md lines
  ├─ dense score: host-supplied embedding provider
  ├─ sparse score: local BM25 over name + description + occurred_on + retrieval_terms + metadata
  └─ fusion: RRF
        ↓
top N index lines + MEMORY.md fallback path
```

The retrieval unit is one index line. The stable cache key is the memory `path`; the
positional `lineId` is only a per-run display/debug id. A `lineHash` decides whether that
path's embedding is fresh. The embedding text is `name + description + occurred_on +
retrieval_terms`; the full raw index line is kept only for prompt injection.

There is no retrieval over memory bodies, no reranker in the default hot path, no hidden
LLM selector, and no embedded model inside the package. `retrieval_terms` is the intended
place for answer-bearing routing phrases that should influence pre-recall without embedding
the body. If no provider is configured, MemFlywheel uses the full/truncated index path. If the
provider is configured as `required` but absent, setup fails fast.

The index lines are *cues*, not facts — they tell the model what exists so it can decide
whether to open a body with the host's own read tool.

## Two-segment injection

`buildContext({ root, enabled, query?, indexRetrieval? })` produces two strings:

- **Segment 1 — `systemPrompt` (stable rules).** A fixed block of memory-usage rules. It
  does not change between turns, so it sits as a cache-friendly prefix in the system prompt.
  It tells the model how to treat memory: only the newest set of cues counts; cues are not
  full facts; `Read` a body only when a memory is clearly relevant to the current request;
  do not read the whole memory directory or guess filenames; do not re-read `MEMORY.md`
  unless the index was explicitly truncated; apply what you read; and never reveal the memory
  mechanism to the user.

- **Segment 2 — `preludePrompt` (dynamic index cues).** Either the full/truncated
  `MEMORY.md` index, or the hybrid-retrieved subset plus a `MEMORY.md` fallback path, wrapped
  in `<system-reminder>…</system-reminder>`. When the store is empty, the prelude instead
  instructs the model not to read or guess any memory files and to answer from the
  conversation alone.

The host places Segment 1 in the system prompt and Segment 2 as a prelude before the user's
message. Because the prelude is wrapped in `<system-reminder>`, the after-turn extraction
path can strip it back out cleanly (see [`extraction.md`](extraction.md)).

## The deterministic pipeline

`buildContext` runs, in order:

1. `scanAllMemoryFiles(root)` — walk the tree, parse headers, sort by `mtime` desc, no
   prompt-manifest cap.
2. `syncMemoryIndex(root, entries)` — rewrite `MEMORY.md` from the scan.
3. `readMemoryIndex(root)` — read it back.
4. `truncateIndex(content)` — enforce ≤ 200 lines and ≤ 25 000 UTF-8 bytes, appending a
   truncation marker when cut.
5. `applyAgingHints(content, entries)` — append the "未更新，建议验证" hint to stale
   `context` / `ambient` lines.
6. Optional index retrieval — only when `query` and `indexRetrieval.embeddingProvider`
   are present and the size gate says the full index does not already fit. Runtime provider
   failures reuse the full/truncated index path for that turn; invalid selected paths still
   fail fast.

When `enabled` is `false`, `buildContext` returns empty strings and performs no scan or
injection.

## Truncation and aging at recall time

The index can grow past the model's useful context, so it is bounded before injection:

- **Line cap:** 200 lines.
- **Byte cap:** 25 000 UTF-8 bytes.
- **Marker:** when truncated, a comment is appended telling the model it may `Read MEMORY.md`
  to see the rest — and the system rules say *not* to re-read it otherwise.

Aging hints (30 days, `context`/`ambient` only) are appended to individual lines so the model
can weigh staleness when deciding whether to act on or re-verify a memory.

## What the model does with it

Given the rules and the index cues, the host's main agent follows a progressive load path:

```
prompt-build
  ├─ systemPrompt: stable memory rules
  └─ preludePrompt: MEMORY.md cues
        │
        ▼
main agent sees matching path
        │
        ├─ no relevant cue → answer from current turn
        │
        └─ relevant cue → host Read(<type>/<memory>.md)
                 │
                 ▼
          compressed memory body
                 │
                 ├─ enough detail → answer
                 │
                 └─ needs provenance / exact execution details
                        → host Read(.memflywheel/sources/session-<hash>.jsonl, line range)
```

The model:

- Treats each line as a cue and ignores lines that are not relevant to the current request.
- Opens a body with `Read` only when a memory is clearly relevant — including when it affects
  *how* to answer (structure, defaults, terminology, collaboration path), not only *whether*
  it can answer.
- Applies what it reads, and never tells the user that it consulted memory.

All of that is the model's judgment. MemFlywheel's job ends at handing it bounded index cues
and stable rules; the host's main agent decides whether and how to read memory bodies.
