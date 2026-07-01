# Changelog

All notable changes to MemFlywheel will be documented in this file.

The format follows Keep a Changelog, and this project uses semantic versioning
for published packages.

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
