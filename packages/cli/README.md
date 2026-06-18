# @memscribe/cli

The local governance loop over a MemScribe memory root: inspect, write, validate,
and consolidate memories from the command line. Built directly on
[`@memscribe/core`](https://www.npmjs.com/package/@memscribe/core); zero runtime dependencies.

The CLI never calls an LLM. `dream apply` runs only the deterministic
consolidation pre-pass. The two LLM injection points — the extraction and dream
subagents (`ExtractionAgentRunner`, `DreamAgentRunner`), both tool-calling loops —
live in `@memscribe/sdk`, not here.

## Install / run

```bash
pnpm --filter @memscribe/cli build
node packages/cli/dist/index.js <command> [options]
# or, once published / linked, the `memscribe` bin.
```

## Memory root resolution

`--root <dir>` wins; otherwise `MEMSCRIBE_HOME`; otherwise an OS data directory
(`<appData>/memscribe/memory`).

## Global options

| Option | Effect |
| --- | --- |
| `--root <dir>` | Memory root override |
| `--json` | Machine-readable output where supported |
| `--no-audit` | Skip the audit log for this invocation |

## Commands

| Command | Description |
| --- | --- |
| `init` | Create the memory root directory |
| `list` | List memory entries (mtime DESC) |
| `read <relativePath>` | Print one memory document |
| `context` | Print the two-segment recall injection (stable rules + `<system-reminder>` index) |
| `write` | Create/update a memory from flags or `--stdin` body |
| `doctor` | Report structural health findings (exits 1 if any are errors) |
| `rebuild-index` | Regenerate `MEMORY.md` from disk |
| `dream plan` | Print the deterministic consolidation plan |
| `dream apply` | Apply the deterministic consolidation plan |
| `mcp` | Launch the MemScribe MCP server (stdio) |

### `write`

```bash
memscribe write --type style --filename tone.md \
  --name "Tone" --description "prefers concise replies" \
  --body "Keep answers short and direct."

# body from stdin
echo "Working on MemScribe." | memscribe write --type context \
  --filename proj.md --name "Project" --stdin
```

`--type` must be one of: `identity preference style workflow context ambient`.
Filenames are flat `*.md`. Frontmatter carries only `name` / `description` /
`type` (plus `created_at` / `updated_at`, stamped by core). The write always
redacts `<private>...</private>` spans and resyncs `MEMORY.md`. Hard-secret
refusal is available through SDK/MCP configuration; the CLI command is the
manual write path and does not run an extraction subagent.

### `dream`

```bash
memscribe dream plan --json     # show deterministic ops
memscribe dream apply           # apply them, then resync the index
```

The deterministic planner emits `delete-duplicate` (exact content dupes) and
`relocate` (path/type mismatches). Near-duplicate merges and type
recategorization need semantics and are left to the SDK's `dreamRunner` (the
tool-calling consolidation subagent).

### `mcp`

Thin launcher: spawns the `memscribe-mcp` bin with stdio forwarded, passing the
resolved root via `MEMSCRIBE_HOME`. Requires `@memscribe/mcp-server`.

## Exit codes

`0` success · `1` runtime failure (not found, write error, health errors) ·
`2` usage error (bad flags, unknown command, malformed input).
