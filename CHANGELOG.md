# Changelog

All notable changes to MemScribe will be documented in this file.

The format follows Keep a Changelog, and this project uses semantic versioning
for published packages.

## [0.1.0] - 2026-06-16

### Added

- Initial MemScribe public release.
- File-native memory storage with Markdown bodies and YAML frontmatter.
- Rebuildable `MEMORY.md` index and full-index recall.
- Core memory tools: `memory_list`, `memory_search`, `memory_read`,
  `memory_save`, `memory_update`, and `memory_archive`.
- SDK lifecycle integration through `createMemScribe`.
- Tool-calling extraction and dream runners injected through canonical model ports.
- MCP stdio server with `memory_context`, `memory_read`, and `memory_save`.
- CLI governance commands for local memory roots.
- Host adapters for Hermes, OpenCode, OpenClaw, Pi, Codex, and Claude Code.
- Runnable examples for Hermes, OpenClaw, and Pi.
