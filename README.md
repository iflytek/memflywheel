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
  <a href="https://www.npmjs.com/package/@iflytekopensource/adapters"><img alt="npm" src="https://img.shields.io/npm/v/%40iflytekopensource%2Fadapters?label=npm"></a>
  <a href="https://www.npmjs.com/package/@iflytekopensource/adapters"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40iflytekopensource%2Fadapters?label=downloads"></a>
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
    <td><strong>Harness-native</strong><br>Pi, Hermes, OpenCode, and OpenClaw are supported through npm packages.</td>
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

Pi:

```sh
pi install npm:@iflytekopensource/adapters
```

Hermes:

```sh
npm install -g @iflytekopensource/hermes
memflywheel-hermes-install
hermes config set memory.provider memflywheel
```

OpenCode:

```sh
opencode plugin @iflytekopensource/adapters --global
opencode run --dir /path/to/project "your task"
```

OpenClaw:

```sh
openclaw plugins install npm:@iflytekopensource/adapters
openclaw config set plugins.slots.memory memflywheel
openclaw config set plugins.entries.memflywheel.hooks.allowConversationAccess true
openclaw config set plugins.entries.memflywheel.hooks.allowPromptInjection true
openclaw gateway run --force
```

MemFlywheel installs into each host as a native memory plugin. The host keeps
owning models, tools, permissions, and sessions; MemFlywheel adds recall,
turn-end extraction, dream consolidation, and learned skills.

Embedding pre-recall is optional. Without it, MemFlywheel still works and
injects up to 200 generated `MEMORY.md` index lines directly. Once your memory
index grows beyond that, start any OpenAI-compatible embeddings endpoint and
export these variables before starting the host; pre-recall then turns on
automatically and injects only the most relevant index entries.

```sh
export MEMFLYWHEEL_EMBEDDING_ENDPOINT="https://embedding-gateway.example.com/v1"
export MEMFLYWHEEL_EMBEDDING_API_KEY="..."
export MEMFLYWHEEL_EMBEDDING_MODEL="text-embedding-3-small"
```

Host setup, embedding pre-recall, verification, and troubleshooting live in
[`docs/integrations.md`](docs/integrations.md).

## Install Packages

| Package                                                                                    | Role                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`@iflytekopensource/adapters`](https://www.npmjs.com/package/@iflytekopensource/adapters) | Pi, OpenCode, OpenClaw, and the shared host-adapter runtime used by Hermes |
| [`@iflytekopensource/hermes`](https://www.npmjs.com/package/@iflytekopensource/hermes)     | Hermes MemoryProvider installer and skill mirror                           |

Internal workspace packages keep the code split by responsibility; users install
only the host package they need.

## Evaluation

MemFlywheel uses LoCoMo-oriented regression checks to keep long-term-memory
behavior measurable while the recall, extraction, and learned-skill loops
evolve. See [`docs/evaluation.md`](docs/evaluation.md).

## Documentation

| Document                                                               | Content                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                         | Storage layout, recall, extraction, dream, skill loop, package boundaries         |
| [`docs/integrations.md`](docs/integrations.md)                         | Pi, Hermes, OpenCode, OpenClaw, embedding pre-recall, SDK hooks, adapter boundary |
| [`docs/native-memory-comparison.md`](docs/native-memory-comparison.md) | Host-native long-term memory capabilities and cost                                |
| [`docs/evaluation.md`](docs/evaluation.md)                             | LoCoMo position and local regression checks                                       |
| [`docs/release.md`](docs/release.md)                                   | Versioning, npm release channel, publish checklist                                |
| [`CHANGELOG.md`](CHANGELOG.md)                                         | Release notes for public npm package versions                                     |
| [`NOTICE`](NOTICE), [`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES)     | Project notice and third-party license disclosure                                 |

## Open-Source Boundary

MemFlywheel is a foundation component inside an Agent Harness. It stays
file-native, model-agnostic, and host-first; it does not absorb the main Agent,
model service, tool permissions, or skill execution into itself.

## 💬 Community

Join the Astron Open Source Community (WeCom Group) to discuss and collaborate:

<img src="https://github.com/iflytek/astron-agent/raw/main/docs/imgs/WeCom_Group.png" alt="WeCom Group" width="300" />
