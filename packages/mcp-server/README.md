# @memscribe/mcp-server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server over
[`@memscribe/core`](https://www.npmjs.com/package/@memscribe/core). It exposes a deliberately minimal memory surface:
the full memory index as a context prelude, single-document reads, and explicit
saves. There is **no search tool** — MemScribe injects the whole index and lets
the caller decide what to read (no retrieval, ranking, or embeddings).

Zero runtime dependencies (Node stdlib + `@memscribe/core` only). Transport is
newline-delimited JSON-RPC 2.0 over stdin/stdout.

## Run

```bash
memscribe-mcp
```

The memory root resolves via `MEMSCRIBE_HOME`, else the OS data directory
(`getMemoryRoot` in `@memscribe/core`).

```jsonc
// Example MCP client config entry
{
  "mcpServers": {
    "memscribe": {
      "command": "memscribe-mcp",
      "env": { "MEMSCRIBE_HOME": "/path/to/memory" }
    }
  }
}
```

## Tools

| Tool             | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `memory_context` | Return the full prelude: stable recall rules + the complete `MEMORY.md` index. No arguments. |
| `memory_read`    | Read one memory document body by `relativePath` (e.g. `context/project.md`). Returns the body without frontmatter. |
| `memory_save`    | Create/overwrite one memory document. `<private>` redaction and MCP's hard-secret refusal are enforced; the index is re-synced. |

`memory_save` arguments:

```jsonc
{
  "type": "preference",      // identity | preference | style | workflow | context | ambient
  "name": "语气偏好",         // single-line frontmatter title
  "description": "简洁",      // optional single-line summary
  "body": "回答要简洁直接"     // markdown body
}
```

The filename is derived from `name` by the core writer.

There is intentionally no `memory_search` tool.

## Resources

| URI                   | Content                                                       |
| --------------------- | ------------------------------------------------------------- |
| `memscribe://index`    | The derived `MEMORY.md` index (`text/markdown`).              |
| `memscribe://manifest` | One line per entry: `[type] path (date): description` (`text/plain`). |

## Prompts

| Name                    | Content                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `memscribe.with_memory`  | A single user message: stable recall rules followed by the current index, ready to prepend. |

## Develop

```bash
pnpm --filter @memscribe/mcp-server build
pnpm --filter @memscribe/mcp-server test
```
