# MemFlywheel

MemFlywheel is an open-source, file-native long-term memory layer for AI agents.
It helps agents recall relevant context before a task, extract durable knowledge
after each run, consolidate memory while idle, and turn repeated workflows into
reusable learned skills.

<p>
  <a href="https://github.com/iflytek/memflywheel"><strong>View on GitHub</strong></a>
  ·
  <a href="https://www.npmjs.com/package/@iflytekopensource/memflywheel"><strong>Install from npm</strong></a>
  ·
  <a href="integrations.html"><strong>Integration guide</strong></a>
  ·
  <a href="https://github.com/iflytek/memflywheel/blob/main/README.zh.md"><strong>简体中文</strong></a>
</p>

![MemFlywheel overview](assets/readme/01-overview.png)

## Agent memory that stays inspectable

MemFlywheel stores Markdown memories, YAML metadata, source traces, and learned
skills as ordinary files. Developers can inspect, diff, review, back up, and
version the agent's long-term knowledge instead of placing it behind an opaque
memory service.

| Capability                | What it gives you                                                            |
| ------------------------- | ---------------------------------------------------------------------------- |
| File-native memory        | Auditable Markdown memories and source traces                                |
| Progressive recall        | Index cues followed by relevant memory bodies, evidence, and skills          |
| Post-run learning         | Turn-end extraction plus idle-time consolidation and repair                  |
| Learned skills            | Repeated workflows can become explicit, reusable skills                      |
| Agent-harness integration | One npm package supports Pi, Hermes, OpenCode, and OpenClaw                  |
| Model-agnostic core       | The host retains model access, credentials, tools, permissions, and sessions |

## Quick start

Choose your agent harness:

### Pi

```sh
pi install npm:@iflytekopensource/memflywheel
```

### Hermes

```sh
npm install -g @iflytekopensource/memflywheel
memflywheel-hermes-install
hermes config set memory.provider memflywheel
```

### OpenCode

```sh
opencode plugin @iflytekopensource/memflywheel --global
```

### OpenClaw

```sh
openclaw plugins install npm:@iflytekopensource/memflywheel
openclaw config set plugins.slots.memory memflywheel
```

Node.js 22.19 or later is required. Continue with the
[full integration and troubleshooting guide](integrations.md).

## Learn more

- [Architecture](architecture.md): storage, recall, extraction, consolidation, and
  package boundaries
- [Integrations](integrations.md): Pi, Hermes, OpenCode, OpenClaw, and optional
  embedding pre-recall
- [Evaluation](evaluation.md): LoCoMo-oriented long-term-memory regression checks
- [Releases](release.md): versioning and npm release workflow

## Contribute

Contributions to host integrations, memory behavior, tests, documentation, and
developer experience are welcome.

- Read the [contribution guide](https://github.com/iflytek/memflywheel/blob/main/CONTRIBUTING.md).
- Browse [good first issues](https://github.com/iflytek/memflywheel/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
  and [help wanted issues](https://github.com/iflytek/memflywheel/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22).
- [Report a bug or propose a feature](https://github.com/iflytek/memflywheel/issues/new/choose).
- Review an [open pull request](https://github.com/iflytek/memflywheel/pulls).

MemFlywheel is open source under the
[Apache License 2.0](https://github.com/iflytek/memflywheel/blob/main/LICENSE).
