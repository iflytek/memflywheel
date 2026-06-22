# Integrations

MemScribe is embedded through SDK lifecycle hooks and host adapters. A real
integration must be owned by the host Agent Harness, because the host owns
lifecycle events, model access, authentication, prompt assembly, filesystem
tools, and skill execution policy.

## Lifecycle Contract

Every host integration maps concrete host events onto the same MemScribe calls:

| Host event | MemScribe call | Effect |
| --- | --- | --- |
| Prompt build | `onPromptBuild(sessionId)` | Return stable memory rules plus the full `MEMORY.md` index prelude, and optionally learned-skill routes. |
| Turn end | `onTurnEnd(sessionId, messages)` | Append transcript/tool trajectory, run extraction, then optionally run skill evolution and dream coordination. |
| Agent/session end | `onAgentEnd(sessionId)` / `onSessionEnd(sessionId)` | Flush not-yet-processed messages and close session state. |
| Idle/scheduled | `onIdle(gate)` | Run gated dream consolidation. |

The host decides where prompt segments go, how messages and tool calls are
represented, when lifecycle events fire, and which model channel is used.
MemScribe consumes normalized inputs and writes the file-native memory/skill
state.

## SDK Surface

`@memscribe/sdk` is the runtime integration surface:

| SDK part | Responsibility |
| --- | --- |
| `createMemScribe` | Session state, recall hooks, extraction scheduling, dream scheduling, skill-loop orchestration. |
| `ExtractionAgentRunner` | Host-injected tool-calling subagent that reads the manifest and writes memory files through `read/write/edit/bash/glob/grep`. |
| `DreamAgentRunner` | Host-injected tool-calling subagent that consolidates memory files through the same tools. |
| `learningLoop` | Optional turn-end skill evolution after successful extraction. |
| `skillRecall` | Optional prompt-build learned-skill route injection. |

Core stays deterministic: storage, frontmatter validation, lock handling,
privacy filtering, audit, cursor advancement, index rebuilds, and structural
dream pre-pass. The host or `@memscribe/model` adapter owns all model calls.

## Host Adapter Surface

`@memscribe/adapters` translates concrete hosts into the SDK contract. The
adapter layer should stay thin:

| Adapter job | Boundary |
| --- | --- |
| Lifecycle mapping | Translate host events into prompt-build, turn-end, session-end, agent-end, and idle calls. |
| Payload normalization | Convert host transcript/tool trajectory into `ExtractionMessage[]`. |
| Model port | Wrap the host-owned model channel into MemScribe's canonical tool-call protocol. |
| Capability gate | Expose whether the host can run recall-only, memory-loop, dream-loop, or full skill-loop. |
| Installation | Apply and verify host-side wiring without changing MemScribe semantics. |

The adapter must not invent retrieval, silently parse model text as tool calls,
or execute learned skills inside MemScribe. If a host lacks a native structured
tool-call model port, the integration should fail fast for extraction/dream/skill
loops rather than pretending to be connected.

## Capability Levels

| Level | Required host capabilities | MemScribe behavior |
| --- | --- | --- |
| Recall | Prompt injection + host filesystem read tools | Inject memory/skill indexes; host's main Agent decides what to read. |
| Memory loop | Recall + canonical structured tool-call model + turn transcript | Turn-end extraction and idle dream can write memory files. |
| Skill loop | Memory loop + tool-call trajectory + learned-skill store wiring | Turn-end extraction, skill evolution, dream memory compression, and skill route recall are connected. |

Pi is the first-class target for the complete path. Other hosts should be wired
by adding a host adapter and model-port mapper without changing core memory or
skill semantics.
