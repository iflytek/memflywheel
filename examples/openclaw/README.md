# OpenClaw integration example (best-effort, still runnable)

OpenClaw's plugin API lets a plugin read prompt/messages via hooks and inject
context, but does **not** expose a direct model-call interface — a plugin cannot
drive inference itself. So:

- **Recall + injection are first-class**: the plugin claims the memory slot via
  `registerMemoryCapability` and returns `prependContext` on prompt build.
- **Extraction** runs as a tool-calling subagent on MemScribe's own **default
  fetch tool-completion**: set `MEMSCRIBE_LLM_API_KEY` (and optionally
  `MEMSCRIBE_LLM_ENDPOINT` / `_MODEL`).

An MCP bridge (`@memscribe/mcp-server`) is also available for hosts that prefer the
tool path (`context` / `read` / `save`).

## Lifecycle mapping

| OpenClaw hook          | scribe hook        | what the adapter does                         |
| ---------------------- | ---------------- | --------------------------------------------- |
| `before_agent_start`   | `onSessionStart` | register capability + ensure dir              |
| `context:inject`       | `onPromptBuild`  | return `prependContext = scribe.preludePrompt`  |
| `agent_end`            | `onTurnEnd`      | fire-and-forget extraction subagent (default-fetch) |
| `idle:watch`           | `onIdle`         | gate-checked dream                            |

## Files

- `plugin.mjs` — `register(api)`: registerMemoryCapability + bind hooks +
  `defaultExtractionAgentFromEnv()`.
- `run.mjs` — a mock OpenClaw host driving the hooks + `connect` into
  `~/.openclaw/openclaw.json` (a temp file in the example).

## Install

```bash
node -e "import('@memscribe/adapters').then(m => m.connect(m.openclawAdapter, { apply: true }))"
```

## Run the smoke test

```bash
pnpm -r build
USE_FAKE=1 node examples/openclaw/run.mjs
```
