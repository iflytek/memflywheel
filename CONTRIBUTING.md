# Contributing to MemFlywheel

Thanks for helping improve MemFlywheel. Contributions of code, tests,
documentation, bug reports, integration feedback, and pull-request reviews are
all welcome.

This guide covers project-specific workflows. For broader community governance
and contribution policy, see the
[iFLYTEK Open Source Community](https://github.com/iflytek/community). All
participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).

MemFlywheel is a file-native long-term memory layer for AI agents. It is a
memory foundation component inside an Agent Harness—not a model, agent
framework, or vector database.

## Choose a Way to Contribute

- Browse [`good first issue`](https://github.com/iflytek/memflywheel/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
  and [`help wanted`](https://github.com/iflytek/memflywheel/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22)
  tasks.
- [Report a reproducible bug](https://github.com/iflytek/memflywheel/issues/new?template=bug_report.md).
- [Propose a feature](https://github.com/iflytek/memflywheel/issues/new?template=feature_request.md)
  before investing in a large implementation.
- Improve setup instructions, examples, tests, or host integrations.
- Review an [open pull request](https://github.com/iflytek/memflywheel/pulls)
  and leave focused, reproducible feedback.

For questions and troubleshooting, follow [`SUPPORT.md`](SUPPORT.md). Report
security vulnerabilities privately through the process in
[`SECURITY.md`](SECURITY.md), not in a public issue.

## Development Setup

### Prerequisites

- Git
- Node.js 22.19 or later
- pnpm 11.5.2 (the version declared in `package.json`)

Fork the repository on GitHub, then clone your fork and install dependencies:

```sh
git clone https://github.com/YOUR-USERNAME/memflywheel.git
cd memflywheel
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install --frozen-lockfile
```

Add the upstream repository so your branch can stay current:

```sh
git remote add upstream https://github.com/iflytek/memflywheel.git
git fetch upstream
git switch -c type/short-description upstream/main
```

Use a focused branch name such as `feat/...`, `fix/...`, `docs/...`, `test/...`,
or `chore/...`.

## Repository Map

| Path                   | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `packages/core`        | File-native storage, recall, extraction, consolidation        |
| `packages/embeddings`  | Optional OpenAI-compatible embedding pre-recall               |
| `packages/sdk`         | Model-driven learning loops and host-facing SDK surfaces      |
| `packages/skills`      | Learned-skill representation and utilities                    |
| `packages/memflywheel` | Public Pi, Hermes, OpenCode, and OpenClaw integration package |
| `docs`                 | Architecture, integrations, evaluation, and release guides    |
| `examples`             | Host integration examples                                     |
| `e2e`                  | Cross-host end-to-end coverage                                |

## Development Commands

```sh
pnpm build          # Build all workspace packages
pnpm test           # Run package tests
pnpm run lint       # Run ESLint
pnpm run format     # Format supported files
pnpm run ci         # Run the complete local quality gate
```

For a documentation-only pull request, `pnpm run format:check` is the minimum
relevant check. Run `pnpm run ci` whenever code, package metadata, workflows, or
executable examples change.

## Design Boundaries

Please keep changes inside the public MemFlywheel scope:

| Area      | Rule                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Storage   | Markdown files plus YAML frontmatter are the source of truth.                                                                          |
| Index     | `MEMORY.md` is a rebuildable index. Do not hand-edit it.                                                                               |
| Recall    | Full-index recall only. Do not add embeddings, BM25, top-k, or vector search to the core recall contract.                              |
| LLM calls | `@memflywheel/core` must not call LLMs directly. Write-side tasks use the SDK's Pi Agent Core runner and host-resolved pi-ai bindings. |
| Naming    | Use `MemFlywheel`, `memflywheel`, `@memflywheel/*`, and `MEMFLYWHEEL_*`.                                                               |
| Host role | Hosts continue to own models, credentials, tools, permissions, and sessions.                                                           |

If a proposal would change one of these boundaries, open an issue first and
explain the use case and trade-offs.

## Make a Focused Change

1. Reproduce the issue or describe the desired behavior.
2. Add or update tests for behavior changes.
3. Implement the smallest coherent change.
4. Update public documentation when commands, configuration, or behavior change.
5. Run the relevant checks and inspect the final diff.

Keep commits focused and avoid unrelated formatting churn. Conventional commit
subjects are preferred, for example:

```text
feat(core): preserve source traces during extraction
fix(openclaw): wait for background memory writes

docs: clarify Hermes installation
```

## Pull Request Checklist

Before opening a pull request:

- [ ] The branch is current with `upstream/main`.
- [ ] Tests cover changed behavior.
- [ ] `pnpm run ci` passes, or the PR explains why a narrower documentation-only
      check is sufficient.
- [ ] User-facing commands, examples, and documentation are updated.
- [ ] Package metadata still points to `iflytek/memflywheel`.
- [ ] No credentials, private memory content, private paths, old project names,
      or AI-signature footers were added.
- [ ] The change stays within the design boundaries above.
- [ ] The PR links its issue with `Fixes #123` when applicable.

When you open the PR, include a concise summary, validation evidence, and any
special notes reviewers need. Respond to review comments with either a code
change or a short explanation so the decision remains auditable.

## Review Contributions

Reviewing pull requests is a valuable contribution. Check:

- correctness and error paths;
- privacy and credential handling;
- compatibility across supported hosts;
- tests and reproducible validation;
- documentation for changed public behavior;
- adherence to the file-native and host-native boundaries.

Prefer specific comments that explain impact and, where possible, suggest a
verifiable next step.

## Public Hygiene

Do not include credentials, private local paths, internal project names,
private memory files, or AI-generation footers/trailers. Sanitize logs and
examples before posting them publicly.
