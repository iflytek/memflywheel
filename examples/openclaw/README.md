# OpenClaw integration example (recall-only until native model port exists)

OpenClaw's plugin API lets a plugin read prompt/messages via hooks and inject
context, but does **not** expose a direct model-call interface — a plugin cannot
drive inference itself. So:

- **Recall + injection are first-class**: the plugin claims the memory slot via
  `registerMemoryCapability` and returns `prependContext` on prompt build.
- **Extraction / dream / skill evolution do not run natively** until OpenClaw
  exposes an in-process canonical model port or an explicit sidecar. MemFlywheel
  does not parse text as fake tool calls.

## Lifecycle mapping

| OpenClaw hook          | scribe hook        | what the adapter does                         |
| ---------------------- | ---------------- | --------------------------------------------- |
| `before_agent_start`   | `onSessionStart` | register capability + ensure dir              |
| `context:inject`       | `onPromptBuild`  | return `prependContext = scribe.preludePrompt`  |
| `agent_end`            | `onTurnEnd`      | no-op in explicit recall-only mode                  |
| `idle:watch`           | `onIdle`         | gate-checked dream                            |

## Files

- `plugin.mjs` — `register(api)`: registerMemoryCapability + bind hooks +
  `createMemFlywheelHarnessRuntime({ mode: "recall-only" })`.
- `run.mjs` — a mock OpenClaw host driving the hooks + `connect` into
  `~/.openclaw/openclaw.json` (a temp file in the example).

## Install

```bash
node -e "import('@memflywheel/adapters').then(m => m.connect(m.openclawAdapter, { apply: true }))"
```

## Run the smoke test

```bash
pnpm -r build
USE_FAKE=1 node examples/openclaw/run.mjs
```
