# Changelog

All notable changes to MemFlywheel will be documented in this file.

The format follows Keep a Changelog, and this project uses semantic versioning
for published packages.

## [Unreleased]

## [0.1.1] - 2026-07-28

### Added

- Kubernetes-level E2E CI workflow using kind and agent-sandbox CRDs. Deploys
  Pi, Hermes, and OpenClaw agents in separate namespaces with the MemFlywheel
  package baked into custom Docker images, then validates the full memory
  lifecycle against a mock LLM (offline, no API key required).
- Optional embedding pre-recall for large `MEMORY.md` indexes, configured through
  OpenAI-compatible embedding endpoint, API key, model, batch size, and retrieval
  limit environment variables.
- Documentation for the 200-line direct index limit and the optional
  endpoint/API-key setup needed to enable pre-recall.
- Hermes host-write guard and learned-skill synchronization for native host
  integration.

### Changed

- Consolidated the former `@iflytekopensource/adapters` and
  `@iflytekopensource/hermes` distributions into the single public
  `@iflytekopensource/memflywheel` package for all four hosts.
- Unified extraction, dream, and skill evolution on Pi Agent Core with
  host-resolved `pi-ai` model bindings.
- Reused each host's active model, endpoint, credentials, headers, protocol, and
  provider options across Pi, OpenCode, Hermes, and OpenClaw.
- Replaced the internal provider-neutral model package with the optional
  embeddings package and provider-native transports.
- Moved cross-process memory locking to `proper-lockfile` and raised the Node.js
  requirement to 22.19.

### Fixed

- Preserved provider-native assistant replay fields across multi-step tool loops.
- Made OpenCode turn completion and idle delivery serial and idempotent, while
  supporting OpenAI-compatible, Responses, Anthropic, Google, Bedrock, and
  Mistral transports without silent protocol fallback.
- Reused OpenCode and Pi host credentials on every background model turn.
- Declared the OpenClaw plugin API as a compatible semver floor so current
  OpenClaw releases can install the package.

### Security

- Upgraded esbuild to 0.28.1 to resolve security vulnerability (CVE affects
  versions < 0.28.1). Added `overrides` in `pnpm-workspace.yaml` to force the
  patched version.

## [0.1.0] - 2026-07-01

### Added

- Initial MemFlywheel public release.
- File-native memory storage with Markdown bodies and YAML frontmatter.
- Rebuildable `MEMORY.md` index and full-index recall.
- Core ordinary file tools for memory agents: `read`, `write`, `edit`, `bash`,
  `glob`, and `grep`.
- SDK lifecycle integration through `createMemFlywheel`.
- Tool-calling extraction and dream runners injected through canonical model ports.
- Public npm packages: `@iflytekopensource/adapters` and
  `@iflytekopensource/hermes`.
- Native host integration surfaces for Pi, Hermes, OpenCode, and OpenClaw.
- Hermes `MemoryProvider` installer, MemFlywheel runtime bridge, and native skill
  mirror.
- npm release workflow, package dry-run checks, and release documentation.
- Runnable examples for Pi, Hermes, OpenCode, and OpenClaw.
- Dual-registry publishing: npm (`@iflytekopensource/*`) and GitHub Packages
  (`@iflytek/*`) via `scripts/publish-npm.mjs`.

### Fixed

- Preview release workflow: explicitly specify public package paths for
  `pkg-pr-new publish` to resolve `No packages` error when internal packages are
  marked `private: true`.
- Added `.npmrc` to `.gitignore` to prevent accidental commit of temporary auth
  tokens.
- GitHub Packages publishing: rewrite runtime adapter imports in Hermes package
  (`bin/install.mjs`, `bridge/worker.mjs`, `provider/__init__.py`) from
  `@iflytekopensource/adapters` to `@iflytek/adapters` to match the rewritten
  dependency scope.
