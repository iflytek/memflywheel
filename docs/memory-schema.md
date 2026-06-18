# Memory schema

A memory is a Markdown file: a YAML frontmatter block followed by a free-text body. The
file is the source of truth; the `MEMORY.md` index is derived from it.

## File format

```markdown
---
name: 用户称呼
description: 用户偏好的称呼
type: identity
---

叫用户小钟。
```

## Frontmatter fields

The persisted frontmatter carries **only** these fields:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Short, unique display name. |
| `description` | no (defaults to empty) | One-line summary shown in the index. |
| `type` | yes | One of the six memory types below. |
| `created_at` | no | Minimal timestamp metadata. |
| `updated_at` | no | Minimal timestamp metadata. |

There are no other fields. MemScribe deliberately does not carry `scope`, `origin`,
`source_ref`, `confidence`, `status`, `agent`, `project`, or `session`.

### Parsing rules

- Only the first 2048 bytes (`FRONTMATTER_READ_BYTES`) of a file are read to detect and
  parse the header during a scan.
- The block must open on the first line with `---` and close with a second `---` within
  `MAX_FRONTMATTER_LINES`.
- Each line is matched as `key: value`; values are single-line.
- An entry is ignored (not surfaced in scans or the index) unless it has a non-empty `name`
  and a `type` that is one of the six valid types.

## The six memory types

The six valid types are:

| Type | What it holds | Examples |
|---|---|---|
| `identity` | Stable identity facts about the user. | Name, role, profession, long-term background. |
| `preference` | Long-term preferences. | Tool choice, collaboration preference, food preference. |
| `style` | Expression and writing habits. | Tone, length, formatting, summary preference. |
| `workflow` | Working and collaboration patterns. | Debugging habit, decision-making style, approach. |
| `context` | Long-term reusable terminology and conventions. | Project rules, naming conventions, fixed terminology. |
| `ambient` | Long-term peripheral facts related to the user. | Team members, external people, related background. |

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

| Type | Aging threshold |
|---|---|
| `identity` | none (permanent) |
| `preference` | none (permanent) |
| `style` | none (permanent) |
| `workflow` | none (permanent) |
| `context` | 30 days |
| `ambient` | 30 days |

When a `context` or `ambient` entry has not been modified within 30 days, the index line for
it gets a hint appended:

```
（此记忆已有 N 天未更新，使用前建议验证）
```

Aging only annotates the index — it never deletes or modifies the memory file. Acting on a
stale memory is left to the model (which sees the hint) and to the dream pass.
