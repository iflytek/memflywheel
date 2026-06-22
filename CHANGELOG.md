# Changelog

All notable changes to MemScribe will be documented in this file.

The format follows Keep a Changelog, and this project uses semantic versioning
for published packages.

## [0.1.0] - 2026-06-16

### Added

- Initial MemScribe public release.
- File-native memory storage with Markdown bodies and YAML frontmatter.
- Rebuildable `MEMORY.md` index and full-index recall.
- Core ordinary file tools for memory agents: `read`, `write`, `edit`, `bash`,
  `glob`, and `grep`.
- SDK lifecycle integration through `createMemScribe`.
- Tool-calling extraction and dream runners injected through canonical model ports.
- Host adapters for Hermes, OpenCode, OpenClaw, Pi, Codex, and Claude Code.
- Runnable examples for Hermes, OpenClaw, and Pi.
