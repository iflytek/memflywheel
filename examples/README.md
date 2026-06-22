# MemScribe integration examples

One runnable minimal integration per targeted host. Each example wraps the host's
own tool-calling LLM channel into a canonical model or `HostHarnessPort`, builds a
batteries-included scribe with `createMemScribeHarnessRuntime`, mounts the full
lifecycle (session start / prompt build / turn end / idle), and installs +
round-trip-verifies the host wiring with `connect`.

Extraction is a tool-calling subagent loop: the model is handed core's
memory-write tools and writes memory files directly. Every example ships **two**
paths:

- a deterministic, offline **fake canonical model** (used by the smoke test /
  CI): it scripts a multi-step subagent (list -> save two memories -> decline a
  high-risk secret), and
- the **real canonical model** (the host's model channel, or the OpenAI-compatible
  mapper from `@memscribe/model` for standalone examples).

Set `USE_FAKE=1` to force the offline path (the default in CI).

## Layout

```
examples/
  README.md                # this file
  shared/
    fake-model.mjs            # scripted offline subagent (list -> save -> decline)
    transcript.mjs            # sample transcript (a preference + a secret to decline)
  pi/
    extension.mjs          # Pi extension entry: createPiHarnessPort, attach scribe
    run.mjs                # mock Pi host driving the full lifecycle
    README.md
  hermes/
    plugin-register.mjs    # register(ctx): wrap ctx.llm.completeWithTools as canonical model
    run.mjs                # mock Hermes host driving the full lifecycle
    README.md
  openclaw/
    plugin.mjs             # register(api): registerMemoryCapability + recall-only hooks
    run.mjs                # mock OpenClaw host; explicit recall-only mode
    README.md
```

## LLM environment (real path)

When not using the fake, `createOpenAIChatCompletionsModel` (an OpenAI-compatible
`/chat/completions` mapper with a `tools` array) reads:

| Variable                       | Meaning                                   |
| ------------------------------ | ----------------------------------------- |
| `MEMSCRIBE_LLM_ENDPOINT`        | base URL override                         |
| `MEMSCRIBE_LLM_API_KEY`         | key (fallback `OPENAI_API_KEY`)           |
| `MEMSCRIBE_LLM_MODEL`           | model id                                  |
| `MEMSCRIBE_LLM_MAX_TOKENS`      | response cap                              |

## Running

Build the workspace first (`pnpm -r build`), then:

```bash
USE_FAKE=1 node examples/pi/run.mjs
USE_FAKE=1 node examples/hermes/run.mjs
USE_FAKE=1 node examples/openclaw/run.mjs
```

Each `run.mjs` drives `onSessionStart → onPromptBuild → onTurnEnd → context()`,
prints the resulting `MEMORY.md`, and (under `USE_FAKE=1`) acts as a smoke test:
it exits non-zero unless the subagent's two memories were written and the
high-risk secret was kept off disk.
