# Pi integration example

Real integration: a Pi `.js`/`.mjs` extension wraps Pi's per-session auxiliary
tool-calling completion into a `toolCompletion`, builds the scribe with
`createHostMemScribe`, and attaches the `pi` adapter so the lifecycle fires on Pi's
events. Extraction is a tool-calling subagent loop that writes memory files
directly.

## Files

- `extension.mjs` — the Pi extension entry (`export default function(pi)`): wraps
  `pi.auxiliaryComplete` as `toolCompletion`, builds the scribe, `piAdapter.attach`.
- `run.mjs` — a mock Pi host driving session:ensure → turn:build → agent_end →
  learning:idle, printing `MEMORY.md`, then `connect` (install + verify).

## Install into a real Pi

1. Copy `extension.mjs` to `~/.pi/agent/extensions/memscribe/index.mjs`.
2. Add it to `~/.pi/agent/settings.json`:

   ```bash
   node -e "import('@memscribe/adapters').then(m => m.connect(m.piAdapter, { apply: true }))"
   ```

   This writes the wiring marker into `~/.pi/agent/settings.json` and verifies it
   round-trips.

## Run the smoke test

```bash
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

Real model: drop `USE_FAKE` and set `MEMSCRIBE_LLM_API_KEY` (the example falls
back to the default fetch tool-completion when Pi's own channel is not in scope).
