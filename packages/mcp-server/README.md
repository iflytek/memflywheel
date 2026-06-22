# @memscribe/mcp-server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server over
[`@memscribe/core`](https://www.npmjs.com/package/@memscribe/core). It exposes
root-bound ordinary file tools plus prompt/resources for memory recall. The full
index is available through `memscribe.with_memory` and `memscribe://index`; file
changes go through `read` / `write` / `edit` / `bash` / `glob` / `grep`.

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

| Tool | Purpose |
| --- | --- |
| `read` | Read a file or directory under the memory root. |
| `write` | Write a typed memory Markdown file; validation, privacy redaction, secret refusal, atomic write, audit, and index sync are enforced. |
| `edit` | Exact string replacement in one file under the memory root. |
| `bash` | Run a shell command under the memory root, mainly for archival moves. |
| `glob` | Match files by glob pattern. |
| `grep` | Search file contents by regular expression. |

`write` arguments:

```jsonc
{
  "filePath": "preference/语气偏好.md",
  "content": "---\ntype: preference\nname: 语气偏好\ndescription: 简洁\n---\n\n回答要简洁直接\n"
}
```

Prompt recall uses `prompts/get` with `memscribe.with_memory`; raw index and
manifest are also available as MCP resources.

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
