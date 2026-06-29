# Memory schema

A memory is a Markdown file: a YAML frontmatter block followed by a free-text body. The
file is the source of truth; the `MEMORY.md` index is derived from it.

## File format

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

## Frontmatter fields

The persisted frontmatter carries **only** these fields:

| Field             | Required                                                          | Meaning                                                                          |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `name`            | yes                                                               | Short, unique display name.                                                      |
| `description`     | no (defaults to empty)                                            | One-line summary shown in the index.                                             |
| `type`            | yes                                                               | One of the six memory types below.                                               |
| `retrieval_terms` | no for existing files, required for new/updated extraction writes | Short routing phrases used by index-layer retrieval; not a body summary.         |
| `occurred_on`     | no                                                                | Event date (`YYYY-MM-DD`) when the fact is tied to a resolvable real-world date. |
| `created_at`      | no                                                                | Minimal timestamp metadata.                                                      |
| `updated_at`      | no                                                                | Minimal timestamp metadata.                                                      |

There are no other fields. MemFlywheel deliberately does not carry `scope`, `origin`,
`source_ref`, `confidence`, `status`, `agent`, `project`, or `session`.

`retrieval_terms` is a YAML list of short index-routing phrases:

```yaml
retrieval_terms:
  - relationship status
  - single
  - single parent
  - adoption
```

These terms are used by embedding/BM25 over `MEMORY.md` so relevant files can be routed
without embedding the memory body. Keep them grounded in the fact itself: concrete entities,
dates, state words, and likely question wording. Do not put raw transcript text, secrets,
private data, or long body sentences into `retrieval_terms`.

Source trace references are not frontmatter. When a memory is written by the extraction
loop, the file-tool executor appends a body section like this:

```markdown
## Sources

- .memflywheel/sources/session-<hash>.jsonl#L10-L18
```

Those references point to cleaned execution-trace JSONL written under `.memflywheel/sources/`.
Multiple memory files produced from the same extraction pass can point to the same source
file and line range. Cursor context is visible to the extraction agent but is not written
again to the source trace; only the newly processed messages for that pass are appended. A
memory updated across multiple turns can accumulate multiple source lines. The hidden source
directory is not scanned into `MEMORY.md`; it is only a drill-down target for a host agent
that has already read a relevant memory file.

### Parsing rules

- Only the first 2048 bytes (`FRONTMATTER_READ_BYTES`) of a file are read to detect and
  parse the header during a scan.
- The block must open on the first line with `---` and close with a second `---` within
  `MAX_FRONTMATTER_LINES`.
- Scalar lines are matched as `key: value`; values are single-line. `retrieval_terms` is the
  only supported YAML list field, using `retrieval_terms:` followed by `  - item` lines.
- An entry is ignored (not surfaced in scans or the index) unless it has a non-empty `name`
  and a `type` that is one of the six valid types.

## The six memory types

The six valid types are:

| Type         | What it holds                                   | Examples                                                |
| ------------ | ----------------------------------------------- | ------------------------------------------------------- |
| `identity`   | Stable identity facts about the user.           | Name, role, profession, long-term background.           |
| `preference` | Long-term preferences.                          | Tool choice, collaboration preference, food preference. |
| `style`      | Expression and writing habits.                  | Tone, length, formatting, summary preference.           |
| `workflow`   | Working and collaboration patterns.             | Debugging habit, decision-making style, approach.       |
| `context`    | Long-term reusable terminology and conventions. | Project rules, naming conventions, fixed terminology.   |
| `ambient`    | Long-term peripheral facts related to the user. | Team members, external people, related background.      |

A file's directory must match its declared `type` (`identity/foo.md` must declare
`type: identity`). A mismatch is a health finding (`path-type-mismatch`) and the dream pass
can fix or relocate it. `style` and `workflow` memories are meant to hold short long-term
signals, not full procedures or SOPs.

## Filenames and paths

- A memory lives at `<type>/<filename>.md`.
- Filenames are validated: no absolute paths, no `.`/`..` or hidden segments, no traversal
  outside the root, must end in `.md`, and must not be a reserved name
  (`MEMORY.md`, `.memory-task-lock`, `.last-extraction`, `.consolidate-lock`, `.audit.log`).
- A stray valid memory written at the root is relocated into its typed directory by both the
  extraction and dream passes (using the file's own `type`).

## Aging

`context` and `ambient` memories age; the other four types are permanent.

| Type         | Aging threshold  |
| ------------ | ---------------- |
| `identity`   | none (permanent) |
| `preference` | none (permanent) |
| `style`      | none (permanent) |
| `workflow`   | none (permanent) |
| `context`    | 30 days          |
| `ambient`    | 30 days          |

When a `context` or `ambient` entry has not been modified within 30 days, the index line for
it gets a hint appended:

```
（此记忆已有 N 天未更新，使用前建议验证）
```

Aging only annotates the index — it never deletes or modifies the memory file. Acting on a
stale memory is left to the model (which sees the hint) and to the dream pass.
