# MemFlywheel

<p align="center">
  <img src="docs/assets/brand/memflywheel-icon.png" alt="MemFlywheel icon" width="104" height="104">
</p>

<p align="center">
  <strong>MemFlywheel</strong><br>
  <span>Turn every Agent run into a smarter start for the next one!</span>
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@memflywheel/core"><img alt="npm" src="https://img.shields.io/npm/v/%40memflywheel%2Fcore?label=npm"></a>
  <a href="https://www.npmjs.com/package/@memflywheel/core"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40memflywheel%2Fcore?label=downloads"></a>
  <a href="https://github.com/iflytek/memflywheel/releases"><img alt="release" src="https://img.shields.io/github/v/release/iflytek/memflywheel?include_prereleases&label=release"></a>
  <a href="https://github.com/iflytek/memflywheel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/iflytek/memflywheel/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.13.0-339933">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/iflytek/memflywheel"></a>
</p>

![MemFlywheel overview](docs/assets/readme/01-overview.png)

MemFlywheel adds a file-native memory flywheel to Agent Harnesses: recall before
execution, extract after execution, and evolve repeated workflows into learned
skills.

<table>
  <tr>
    <td><strong>File-native</strong><br>Markdown memories, source traces, and learned skills stay inspectable and diffable.</td>
    <td><strong>Progressive recall</strong><br>Pre-recall plus layered reads from index cues to evidence.</td>
  </tr>
  <tr>
    <td><strong>Post-run learning</strong><br>Turn-end extraction and dream consolidation keep memory moving.</td>
    <td><strong>Harness-native</strong><br>Pi is supported today; more Agent Harness integrations are planned.</td>
  </tr>
</table>

## Why It Exists

Give your Agent a memory flywheel: recall before it acts, learn after it runs,
and understand you better each time. The host Agent Harness owns lifecycle,
model access, auth, and tools; MemFlywheel owns the memory and learning loop.

## How It Works

```text
Agent Harness
   |
   |  lifecycle / model / auth / tools
   v
MemFlywheel
   |
   |-- pre-recall       -> MEMORY.md index cues
   |-- progressive read -> memory bodies -> source traces -> learned skills
   |-- turn-end         -> durable memory extraction
   |-- idle             -> dream consolidation and repair
   `-- repeated work    -> reusable learned skills
```

<table>
  <tr>
    <td width="50%"><img src="docs/assets/readme/02-lifecycle.png" alt="MemFlywheel lifecycle"></td>
    <td width="50%"><img src="docs/assets/readme/05-skill-flywheel.png" alt="MemFlywheel skill flywheel"></td>
  </tr>
  <tr>
    <td><strong>Memory lifecycle</strong><br>Recall, extract, consolidate, and keep evidence close to the file-native store.</td>
    <td><strong>Skill flywheel</strong><br>Repeated work evolves into reusable learned skills the Agent can inspect and reuse.</td>
  </tr>
</table>

## Quick Start

Install the Pi package:

```sh
pi install npm:@memflywheel/adapters
```

Pi loads the extension declared in `@memflywheel/adapters` and drives
MemFlywheel through native lifecycle events: prompt-build recall, turn-end
extraction, source tracing, and file-native memory writes. Source checkout and
smoke-test paths live in [`docs/integrations.md`](docs/integrations.md).

## Packages

| Package                                                                        | Role                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`@memflywheel/core`](https://www.npmjs.com/package/@memflywheel/core)         | Storage, frontmatter, index, recall, extraction/dream tools, privacy, locks, audit |
| [`@memflywheel/model`](https://www.npmjs.com/package/@memflywheel/model)       | Provider-neutral tool-calling model protocol and OpenAI-compatible mapper          |
| [`@memflywheel/sdk`](https://www.npmjs.com/package/@memflywheel/sdk)           | Lifecycle hooks and extraction / dream / skill-loop orchestration                  |
| [`@memflywheel/skills`](https://www.npmjs.com/package/@memflywheel/skills)     | Learned skill packages, staging, validation, finalize, rollback, recall routing    |
| [`@memflywheel/adapters`](https://www.npmjs.com/package/@memflywheel/adapters) | Host lifecycle mapping for Pi today, with more Agent Harness integrations planned  |

## Evaluation

MemFlywheel uses LoCoMo-oriented regression checks to keep long-term-memory
behavior measurable while the recall, extraction, and learned-skill loops
evolve. See [`docs/extraction-regression.md`](docs/extraction-regression.md)
and [`docs/dream-regression.md`](docs/dream-regression.md).

## Documentation

| Document                                                           | Content                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                     | Storage layout, recall, extraction, dream, skill loop, package boundaries |
| [`docs/integrations.md`](docs/integrations.md)                     | Pi package install, SDK hooks, adapter boundary, host capability levels   |
| [`docs/extraction-regression.md`](docs/extraction-regression.md)   | Extraction subagent real-model regression report                          |
| [`docs/dream-regression.md`](docs/dream-regression.md)             | Dream consolidation real-model regression report                          |
| [`docs/release.md`](docs/release.md)                               | Versioning, npm release channel, publish checklist                        |
| [`NOTICE`](NOTICE), [`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES) | Project notice and third-party license disclosure                         |

## Open-Source Boundary

MemFlywheel is a foundation component inside an Agent Harness. It stays
file-native, model-agnostic, and host-first; it does not absorb the main Agent,
model service, tool permissions, or skill execution into itself.
