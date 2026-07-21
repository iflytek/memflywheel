# MemFlywheel vs Host-Native Memory

MemFlywheel replaces or extends the memory implementation that ships with an
Agent Harness. This page explains what actually changes on each host, what the
memory flywheel adds over a native store, what it costs at runtime, and when
staying on native memory is the right call.

Installation for every host lives in the [README Quick Start](../README.md#quick-start);
per-host wiring, verification tables, and troubleshooting live in
[`integrations.md`](integrations.md). This page only covers _whether_ and _why_.

## What Changes Per Host

| Host     | Install path                                               | Effect on native memory                                                                                                   |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pi       | `pi install npm:@iflytekopensource/adapters`               | Additive: loads as a Pi extension; nothing on the host is disabled                                                        |
| Hermes   | `memflywheel-hermes-install` + `memory.provider` config    | Replacing: the installer disables Hermes' native memory toolset and moves existing `memories/MEMORY.md` aside             |
| OpenClaw | `openclaw plugins install` + `plugins.slots.memory` config | Replacing: OpenClaw enables exactly one memory slot, so `memflywheel` takes the place of the default `memory-core` plugin |
| OpenCode | `opencode plugin @iflytekopensource/adapters --global`     | Additive: loads as an OpenCode plugin; hooks provide recall, extraction, and skills                                       |

Switching back is symmetric: point the Hermes provider or the OpenClaw memory
slot back at the native implementation. The MemFlywheel store is plain Markdown
on disk, so nothing is lost or locked in either direction.

## Capability Comparison

Native memory implementations differ per host, but they are typically a single
store the main agent reads and writes directly. MemFlywheel splits memory into
a read side (recall) and a model-driven write side (extraction, dream, skill
evolution) that runs outside the main agent's turn.

| Dimension          | Typical host-native memory                      | MemFlywheel                                                                                     |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Storage            | Host-specific store, often a single memory file | File-native Markdown tree with typed directories (`identity/`, `preference/`, `workflow/`, ...) |
| Recall             | Whole store or manual lookup                    | Progressive: index cues injected at prompt build, bodies read only when the agent decides to    |
| Writing            | Main agent edits memory in-turn                 | Turn-end extraction by a dedicated subagent, outside the main turn                              |
| Maintenance        | Manual cleanup                                  | Idle-time dream consolidation: dedupe, merge, compress, re-type                                 |
| Repeated workflows | Stay as prose, re-derived every time            | Evolve into learned skills; workflow memory compresses into a route pointing at the skill       |
| Evidence           | None                                            | `## Sources` refs into cleaned session traces under `.memflywheel/sources/`                     |
| Auditability       | Host-dependent                                  | Append-only `.audit.log` for every write, delete, and archive                                   |
| Privacy            | Host-dependent                                  | `<private>` spans redacted on write; optional `refuseSecrets` gate refuses obvious secrets      |
| Portability        | Tied to the host                                | Same store layout on every host; `MEMFLYWHEEL_HOME` points any host at the same tree            |
| Scaling            | Whole store grows into the prompt               | Index capped at 200 lines / 25 000 bytes, with optional embedding pre-recall above that         |

Not every host unlocks every row. Capability depends on what the host exposes —
see the capability levels table in [`integrations.md`](integrations.md#capability-levels):
recall-only needs prompt injection plus file read tools; the memory loop adds a
structured tool-call model and turn transcripts; the skill loop adds tool
trajectories and a learned-skill store.

## Runtime Overhead

MemFlywheel is not free. The flywheel spends model calls after the turn to make
the next turn cheaper and better grounded.

| Cost                 | When                                      | Size                                                                               |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Prompt injection     | Every prompt build                        | Memory rules plus at most 200 index lines / 25 000 bytes; small stores inject less |
| Turn-end extraction  | After each turn with new messages         | One subagent session over the new transcript window, via the host's model channel  |
| Dream consolidation  | Gated: ≥ 24 h elapsed or ≥ 5 sessions     | One consolidation subagent pass over the cleaned store                             |
| Skill evolution      | Only when repeated workflows are detected | Staged checkpoint writes, validated before publish                                 |
| Embedding pre-recall | Optional, stores past ~200 index entries  | Ordinary `/embeddings` calls against your OpenAI-compatible endpoint               |
| Disk                 | Continuous                                | Markdown files, JSONL source traces, and index caches under the memory root        |

The write-side model calls go through the host's own model/auth channel where
the host provides one (Pi, Hermes); on OpenClaw and OpenCode they can use the
`MEMFLYWHEEL_LLM_*` environment variables instead. Recall itself never calls a
model — it is filesystem scan plus injection.

## When To Use Which

| Situation                                                              | Recommendation                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Long-lived assistant that should get better across sessions            | MemFlywheel — extraction and dream compound over time                        |
| Same agent identity used across several harnesses                      | MemFlywheel — one portable store via `MEMFLYWHEEL_HOME`                      |
| Memories must be reviewable, diffable, or shipped through code review  | MemFlywheel — plain Markdown plus audit log                                  |
| Repeated multi-step workflows worth turning into reusable procedures   | MemFlywheel — the skill loop exists for exactly this                         |
| One-shot batch jobs or stateless CI runs                               | Native (or no) memory — there is no next session to invest in                |
| Extremely cost-sensitive turns where post-run model calls are unwanted | Native memory, or run MemFlywheel recall-only on a host without a model port |
| You rely on host-specific memory features MemFlywheel does not replace | Native memory — MemFlywheel only owns the memory and learning loop           |

A practical middle ground is to start recall-only: injection costs a bounded
prompt prefix and no extra model calls, and you can enable the write-side loops
once the memory store proves useful.
