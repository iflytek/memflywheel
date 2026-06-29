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
| Hermes   | Planned/open target          | Needs a structured model capability such as `completeWithTools` for write-side loops         |
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
pi install npm:@memflywheel/adapters
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
