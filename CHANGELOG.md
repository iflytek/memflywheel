# Changelog

All notable changes to MemFlywheel will be documented in this file.

The format follows Keep a Changelog, and this project uses semantic versioning
for published packages.

## [Unreleased]

### Added

- Optional embedding pre-recall for large `MEMORY.md` indexes, configured through
  OpenAI-compatible embedding endpoint, API key, model, batch size, and retrieval
  limit environment variables.
- Documentation for the 200-line direct index limit and the optional
  endpoint/API-key setup needed to enable pre-recall.

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
