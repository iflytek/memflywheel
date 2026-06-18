# Recall

Recall is how a memory store reaches the model on a given turn. MemScribe's answer is
deliberately simple: **inject the whole index every turn and let the model self-select.**

## No retrieval

There is no search step. MemScribe does not compute embeddings, does not rank, does not run
BM25 or any lexical scorer, does not keep an entity index, and does not pick a top-k. Nothing
in the recall path scores a memory against the user's request. Every memory is visible to the
model (as one index line); the model decides which, if any, are relevant.

This is the load-bearing design choice. The index lines are *cues*, not facts — they tell the
model what exists so it can decide whether to open a body.

## Two-segment injection

`buildContext({ root, enabled })` produces two strings:

- **Segment 1 — `systemPrompt` (stable rules).** A fixed block of memory-usage rules. It
  does not change between turns, so it sits as a cache-friendly prefix in the system prompt.
  It tells the model how to treat memory: only the newest set of cues counts; cues are not
  full facts; `Read` a body only when a memory is clearly relevant to the current request;
  do not read the whole memory directory or guess filenames; do not re-read `MEMORY.md`
  unless the index was explicitly truncated; apply what you read; and never reveal the memory
  mechanism to the user.

- **Segment 2 — `preludePrompt` (dynamic full index).** The entire `MEMORY.md` index wrapped
  in `<system-reminder>…</system-reminder>`, re-injected on every turn. When the store is
  empty, the prelude instead instructs the model not to read or guess any memory files and to
  answer from the conversation alone.

The host places Segment 1 in the system prompt and Segment 2 as a prelude before the user's
message. Because the prelude is wrapped in `<system-reminder>`, the after-turn extraction
path can strip it back out cleanly (see [`extraction.md`](extraction.md)).

## The deterministic pipeline

`buildContext` runs, in order:

1. `scanMemoryFiles(root)` — walk the tree, parse headers, sort by `mtime` desc, cap at 200.
2. `syncMemoryIndex(root, entries)` — rewrite `MEMORY.md` from the scan.
3. `readMemoryIndex(root)` — read it back.
4. `truncateIndex(content)` — enforce ≤ 200 lines and ≤ 25 000 UTF-8 bytes, appending a
   truncation marker when cut.
5. `applyAgingHints(content, entries)` — append the "未更新，建议验证" hint to stale
   `context` / `ambient` lines.

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

Given the rules and the full index, the model:

- Treats each line as a cue and ignores lines that are not relevant to the current request.
- Opens a body with `Read` only when a memory is clearly relevant — including when it affects
  *how* to answer (structure, defaults, terminology, collaboration path), not only *whether*
  it can answer.
- Applies what it reads, and never tells the user that it consulted memory.

All of that is the model's judgment. MemScribe's job ends at handing it the complete, bounded,
annotated index.
