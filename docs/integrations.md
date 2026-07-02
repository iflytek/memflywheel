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

| Host     | Status                       | Notes                                                                                    |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Pi       | Implemented first-class path | Adapter, HarnessPort, lifecycle mapping, and canonical model mapping are implemented     |
| Hermes   | Implemented plugin path      | MemoryProvider plugin uses Hermes' host-owned model/auth channel for write-side loops    |
| OpenClaw | Implemented plugin path      | Load the adapter as OpenClaw's memory slot; hooks provide recall, extraction, and skills |
| OpenCode | Implemented plugin path      | Load the adapter as an OpenCode plugin; hooks provide recall, extraction, and skills     |

## Large Index Pre-Recall

By default, prompt recall injects the generated `MEMORY.md` index directly. That
direct path is intentionally capped at 200 index lines and 25 000 bytes. Once a
memory store grows beyond that size, configure an OpenAI-compatible embeddings
endpoint so the adapter can pre-recall the most relevant index lines before the
main Agent sees the prompt.

```text
prompt build
   |
   | <= 200 index lines and <= 25 000 bytes
   |-----------------------------------------> inject MEMORY.md cues directly
   |
   | larger index + embedding env + query
   v
embed MEMORY.md index lines -> hybrid search -> inject Relevant Memory Entries
```

The adapter runtime reads the following environment variables when
`memoryIndexRetrieval` was not supplied explicitly:

| Variable                                         | Set when                     | Meaning                                                                                |
| ------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `MEMFLYWHEEL_EMBEDDING_ENDPOINT`                 | Using a provider or gateway  | Base URL without `/embeddings`, for example `https://embedding-gateway.example.com/v1` |
| `MEMFLYWHEEL_EMBEDDING_BASE_URL`                 | Alias                        | Alias for `MEMFLYWHEEL_EMBEDDING_ENDPOINT`                                             |
| `MEMFLYWHEEL_EMBEDDING_API_KEY`                  | No `OPENAI_API_KEY` fallback | Sent as `Authorization: Bearer ...`; `OPENAI_API_KEY` is used only as fallback         |
| `MEMFLYWHEEL_EMBEDDING_MODEL`                    | Using a non-default model    | Embedding model id and index-cache key; default is `text-embedding-3-small`            |
| `MEMFLYWHEEL_EMBEDDING_BATCH_SIZE`               | Provider needs batching      | Maximum texts per embeddings request                                                   |
| `MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL`             | Need explicit behavior       | `auto`, `required`, or `off`; default is `auto` when retrieval config is found         |
| `MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL_LIMIT`       | Need a different recall size | Retrieved index-line count; default is `30`                                            |
| `MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL_MIN_RECORDS` | Need a different threshold   | Record threshold before pre-recall runs; default is `200`                              |

Example with any OpenAI-compatible embedding service:

```sh
export MEMFLYWHEEL_EMBEDDING_ENDPOINT="https://embedding-gateway.example.com/v1"
export MEMFLYWHEEL_EMBEDDING_API_KEY="..."
export MEMFLYWHEEL_EMBEDDING_MODEL="text-embedding-3-small"
export MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL="auto"
export MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL_LIMIT="30"
```

For managed providers, put the provider key in `MEMFLYWHEEL_EMBEDDING_API_KEY`.
For proxy or gateway setups, point `MEMFLYWHEEL_EMBEDDING_ENDPOINT` at the
OpenAI-compatible gateway URL. MemFlywheel sends ordinary `/embeddings` requests
with a Bearer token; provider-specific auth, routing, or network proxy rules
belong in that gateway or in a custom `memoryIndexRetrieval.embeddingProvider`.

During setup, use `required` instead of `auto` if you want a missing or broken
embedding service to fail the agent turn immediately:

```sh
export MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL="required"
```

To verify pre-recall from the user's point of view:

| Step                                                                    | Expected result                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Configure an OpenAI-compatible embeddings provider or gateway           | `POST /v1/embeddings` succeeds                             |
| Export the `MEMFLYWHEEL_EMBEDDING_*` variables before starting the host | Host process inherits them                                 |
| Run a prompt against a memory store with more than 200 index lines      | `.memflywheel/index/memory-index.json` is created          |
| Ask for a fact that appears after the first 200 index lines             | The agent reads the matched memory file or answers from it |

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

## OpenCode Integration

```sh
opencode plugin @iflytekopensource/adapters --global
opencode run --dir /path/to/project "your task"
```

OpenCode keeps model configuration, tools, permissions, and sessions. The
MemFlywheel plugin uses OpenCode hooks for prompt recall, turn-end extraction,
source traces, skill evolution, and dream consolidation.

If your OpenCode model credentials are stored only inside OpenCode, also export
an OpenAI-compatible write-side model for MemFlywheel before starting OpenCode:

```sh
export MEMFLYWHEEL_LLM_ENDPOINT="https://api.example.com/v1"
export MEMFLYWHEEL_LLM_API_KEY="..."
export MEMFLYWHEEL_LLM_MODEL="deepseek-chat"
```

Prompt recall and embedding pre-recall do not need these variables. Turn-end
extraction, skill evolution, and dream consolidation do.

For non-interactive `opencode run` tests, remember that OpenCode may reject file
reads outside `--dir`. If the model needs to inspect
`~/.config/opencode/memflywheel`, run interactively and approve the read, or use
your test harness' explicit permission override.

## OpenClaw Integration

```sh
openclaw plugins install npm:@iflytekopensource/adapters
openclaw config set plugins.slots.memory memflywheel
openclaw config set plugins.entries.memflywheel.hooks.allowConversationAccess true
openclaw config set plugins.entries.memflywheel.hooks.allowPromptInjection true
openclaw gateway run --force
```

The `plugins.slots.memory` setting is required because OpenClaw enables exactly
one memory plugin slot. If the slot still points at `memory-core`, the
MemFlywheel package is installed but inactive.

If your OpenClaw model credentials are stored only inside OpenClaw, also export
an OpenAI-compatible write-side model for MemFlywheel before starting the
gateway or running `openclaw agent --local`:

```sh
export MEMFLYWHEEL_LLM_ENDPOINT="https://api.example.com/v1"
export MEMFLYWHEEL_LLM_API_KEY="..."
export MEMFLYWHEEL_LLM_MODEL="deepseek-chat"
```

Prompt recall and embedding pre-recall do not need these variables. Turn-end
extraction, skill evolution, and dream consolidation do.

After a real session, MemFlywheel files should appear under
`~/.openclaw/memflywheel/`, including `MEMORY.md`, typed memory documents,
source traces, and learned skills.

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
