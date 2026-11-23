# MemFlywheel integration entries

These examples show host-owned installation and tool-result boundaries. Model routing, credentials, and provider selection remain inside the active host; there is no standalone write-side LLM configuration or mock model path.

```text
Host lifecycle + active model
             |
       HostHarnessPort
             |
   Model + StreamFn resolver
             |
      Pi Agent Core
       /    |    \
Extraction Dream Skill Evolution
```

- `pi/extension.mjs` — Pi extension entry.
- `hermes/plugin-register.mjs` — Hermes plugin registration sketch; the published Python MemoryProvider contains the production bridge.
- `openclaw/plugin.mjs` — OpenClaw plugin entry.
- [`clickhouse/`](clickhouse/README.md) — project a ClickHouse MCP schema result into a timestamped extraction message, keeping response metadata separate from business fields.

Run `pnpm --dir examples smoke` after building the workspace to syntax-check these entries.

Run `pnpm --dir examples test` for the ClickHouse result-projection regressions.
