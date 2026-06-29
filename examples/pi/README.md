# Pi integration example

Real integration: a Pi `.js`/`.mjs` extension wraps Pi's per-session auxiliary
tool-calling completion into `createPiHarnessPort(pi)`, builds the scribe with
`createMemFlywheelHarnessRuntime({ port })`, and attaches the `pi` adapter so the
lifecycle fires on Pi's events. Extraction is a tool-calling subagent loop that
writes memory files directly.

## Files

- `extension.mjs` — the Pi extension entry (`export default function(pi)`): wraps
  Pi as a `HostHarnessPort`, builds the scribe, `piAdapter.attach`.
- `run.mjs` — a mock Pi host driving session:ensure → turn:build → agent_end →
  learning:idle, printing `MEMORY.md`, then `connect` (install + verify).

## Install into a real Pi

Install the published Pi package:

```bash
pi install npm:@memflywheel/adapters
```

Pi loads the extension declared by `@memflywheel/adapters`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./pi-extension/index.mjs"]
  }
}
```

`extension.mjs` in this directory is the readable source equivalent of the
published package entrypoint.

## Run the smoke test

```bash
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

Real model: a real Pi process should expose `completeSimple` (or equivalent) to
`createPiHarnessPort(pi)`. The standalone smoke can use `MEMFLYWHEEL_LLM_*` through
the OpenAI-compatible mapper when Pi's own process is not in scope.
