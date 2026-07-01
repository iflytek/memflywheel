# Integrations

MemFlywheel is embedded through SDK lifecycle hooks and thin host adapters. A
real integration must be owned by the host Agent Harness because the host owns
lifecycle events, model access, authentication, prompt assembly, filesystem
tools, and skill execution policy.

## Lifecycle Contract

| Host event        | MemFlywheel call                                    | Effect                                                                                          |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Prompt build      | `onPromptBuild(sessionId)`                          | Return stable memory rules, `MEMORY.md` cues, and optional learned-skill routes                 |
| Turn end          | `onTurnEnd(sessionId, messages)`                    | Append source trace, run extraction, then optionally run skill evolution and dream coordination |
| Agent/session end | `onAgentEnd(sessionId)` / `onSessionEnd(sessionId)` | Flush not-yet-processed messages and close session state                                        |
| Idle/scheduled    | `onIdle(gate)`                                      | Run gated dream consolidation                                                                   |

## Capability Levels

| Level       | Required host capabilities                                 | Behavior                                                                       |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Recall      | Prompt injection + host filesystem read tools              | Inject indexes; the main Agent reads memory files                              |
| Memory loop | Recall + structured tool-call model + turn transcript      | Turn-end extraction and idle dream can write memory files                      |
| Skill loop  | Memory loop + tool trajectory + learned-skill store wiring | Extraction, skill evolution, dream compression, and skill recall are connected |

If a host lacks a native structured tool-call model port, extraction, dream, and
skill loops should fail fast instead of parsing free-form model text.

## Host Status

| Host     | Status                       | Notes                                                                                        |
| -------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Pi       | Implemented first-class path | Adapter, HarnessPort, lifecycle mapping, and canonical model mapping are implemented         |
| Hermes   | Implemented plugin path      | MemoryProvider plugin uses Hermes' host-owned model/auth channel for write-side loops        |
| OpenClaw | Planned/open target          | Memory injection is the likely first step; full write-side loop needs an OpenClaw model port |
| OpenCode | Planned/open target          | Suitable for hook-native recall first; full loop needs host-owned tool-call model port       |

## Pi Integration

Pi's public contribution path is a Pi package: an npm or git package that
declares its extension entry under the `pi` key in `package.json`.

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./pi-extension/index.mjs"]
  }
}
```

Install the published adapter package into Pi:

```sh
pi install npm:@iflytekopensource/adapters
```

Pi then loads `packages/adapters/pi-extension/index.mjs` from the npm package.
That extension maps Pi lifecycle and tool-calling model access into
`HostHarnessPort`, then builds the MemFlywheel runtime:

```text
Pi package
   |
   | package.json: pi.extensions
   v
pi-extension/index.mjs
   |
   | createPiHarnessPort(pi, { completeSimple })
   v
createMemFlywheelHarnessRuntime({ port })
   |
   +-> context       -> prompt-build recall
   +-> agent_end     -> turn-end extraction
   +-> tool events   -> source trace
   +-> shutdown/idle -> consolidation hooks
```

Source checkout smoke test:

```sh
pnpm -r build
USE_FAKE=1 node examples/pi/run.mjs
```

`@earendil-works/pi-ai` is declared as a Pi peer dependency because Pi provides
its own core packages to extensions. The extension imports `completeSimple` from
`@earendil-works/pi-ai/compat`; MemFlywheel must not bundle Pi core packages into
its tarball.

## Hermes Integration

Hermes loads MemFlywheel as a `MemoryProvider`. Users install the provider from
npm, run the installer once, then select it through Hermes' native memory
config.

```sh
npm install -g @iflytekopensource/hermes
memflywheel-hermes-install
hermes config set memory.provider memflywheel
hermes memory status
```

After that, start Hermes normally:

```sh
hermes --tui
```

The installer writes the plugin into `$HERMES_HOME/plugins/memflywheel` (default
`~/.hermes/plugins/memflywheel`), disables Hermes' native memory toolset, and
moves any existing Hermes native `memories/MEMORY.md` into
`memories.disabled-by-memflywheel/`.

MemFlywheel stores its files under `$MEMFLYWHEEL_HOME` when set, otherwise under
`$HERMES_HOME/memflywheel`:

```text
~/.hermes/memflywheel/
   |
   |-- MEMORY.md                         -> index cues injected at prompt build
   |-- preference/ workflow/ ...         -> file-native memory documents
   |-- .memflywheel/sources/*.jsonl      -> source trace
   |-- learned-skills/*/SKILL.md         -> MemFlywheel learned skills
   `-- .memflywheel-skill-checkpoints/   -> staged skill-evolution checkpoints

~/.hermes/skills/memflywheel/
   `-- */SKILL.md                        -> Hermes-native skill mirrors
```

Source checkout uses the same installer path as npm; the only difference is that
the package is executed from the workspace instead of a global npm install:

```sh
pnpm --filter @iflytekopensource/hermes run build
pnpm --filter @iflytekopensource/hermes run install:local
hermes config set memory.provider memflywheel
```

```text
Hermes CLI
   |
   | memory.provider = memflywheel
   v
~/.hermes/plugins/memflywheel
   |
   | MemoryProvider lifecycle + Hermes call_llm(...)
   v
MemFlywheel runtime
   |
   +-> prefetch   -> prompt-build recall
   +-> sync_turn  -> turn-end extraction
   +-> sync_turn  -> skill evolution + learned-skill mirror sync
   `-> session end -> idle dream consolidation
```

MemFlywheel does not expose a recall tool to the main Hermes model. Recall is
injected through Hermes' memory lifecycle; extraction, dream, and skill evolution
run in the background through Hermes' own model/auth channel.

### Verification

```sh
hermes plugins list | grep memflywheel
hermes memory status
find ~/.hermes/memflywheel -maxdepth 3 -print
find ~/.hermes/skills/memflywheel -maxdepth 3 -print
```

Expected behavior after a real session:

| Check                     | Expected result                                            |
| ------------------------- | ---------------------------------------------------------- |
| Plugin status             | `memflywheel` is enabled                                   |
| Native Hermes memory tool | `agent.disabled_toolsets` contains `memory`                |
| Prompt-build recall       | `MEMORY.md` cues are injected by the memory provider       |
| Turn-end extraction       | Memory files appear under `~/.hermes/memflywheel/<type>/`  |
| Source trace              | JSONL files appear under `.memflywheel/sources/`           |
| Learned skills            | Skills appear under `memflywheel/learned-skills/`          |
| Hermes skill integration  | Mirrors appear under `~/.hermes/skills/memflywheel/`       |
| Dream consolidation       | `.dream-state.json` is updated after gated or forced dream |

### Debugging With A Local Model Proxy

Users do not need a proxy for normal use. For end-to-end debugging, start Hermes
through a wrapper that points both the main model and Hermes auxiliary model
calls at the same OpenAI-compatible proxy:

```sh
run-with-deepseek-proxy.sh hermes --tui
```

That lets request logs show host turns plus MemFlywheel extraction, skill
evolution, and dream calls in one place. In local development we used the same
pattern to confirm the full Hermes path:

```text
Hermes main turn -> extraction -> skill evolution -> dream
```

## Adapter Rules

| Adapter job           | Boundary                                                           |
| --------------------- | ------------------------------------------------------------------ |
| Lifecycle mapping     | Translate host events into SDK hooks                               |
| Payload normalization | Convert host transcript/tool trajectory into `ExtractionMessage[]` |
| Model port            | Wrap host-owned model access into the canonical tool-call protocol |
| Capability gate       | Report recall-only, memory-loop, or skill-loop support             |
| Installation          | Apply and verify host-side wiring without changing core semantics  |

Adapters must not invent retrieval, silently parse model text as tool calls, or
execute learned skills inside MemFlywheel.
