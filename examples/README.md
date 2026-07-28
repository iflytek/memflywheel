# MemFlywheel integration entries

These files show the host-owned installation boundary only. Model routing, credentials, and provider selection remain inside the active host; there is no standalone write-side LLM configuration or mock model path.

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

Run `pnpm --dir examples smoke` after building the workspace to syntax-check these entries.
