# Hermes integration example

Real integration: a Hermes plugin's `register(ctx)` wraps the host LLM facade
(`ctx.llm.acomplete`, with tool calling) into a `toolCompletion`, builds the scribe
with `createHostMemScribe`, and binds the `hermes` adapter to Hermes' real hooks.

## Lifecycle mapping

| Hermes hook         | scribe hook       | what the adapter does                                |
| ------------------- | --------------- | ---------------------------------------------------- |
| `on_session_start`  | `onSessionStart`| ensure memory dir + register session                 |
| `pre_llm_call`      | `onPromptBuild` | inject prelude as `{"context": ...}`; merge rules     |
| `post_llm_call`     | `onTurnEnd`     | fire-and-forget extraction subagent (`user_message` + reply) |
| `on_session_end`    | `onIdle`        | gate-checked dream consolidation                     |

Because Hermes owns the credentials, **no API key is needed** — the extraction
subagent runs on Hermes' own model through `ctx.llm.acomplete`.

## Files

- `plugin-register.mjs` — `register(ctx)`: wrap `ctx.llm.acomplete` as a
  `toolCompletion`, bridge `ctx.register_hook` into the adapter's `on(event)`
  surface, `attach`.
- `run.mjs` — a mock Hermes host driving the four hooks + `connect`.

## Run the smoke test

```bash
pnpm -r build
USE_FAKE=1 node examples/hermes/run.mjs
```
