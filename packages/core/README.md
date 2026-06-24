# @memflywheel/core

The MemFlywheel memory kernel: file-backed Markdown + YAML-frontmatter storage, derived `MEMORY.md` index, progressive index recall, extraction and dream consolidation with pluggable model injection points, privacy redaction, per-root write locking, atomic writes, and an append-only audit log.

Zero runtime dependencies — Node stdlib + TypeScript only. The core never owns model transport or auth; extraction and dream consolidation are supplied by the host through the `ExtractionAgentRunner` and `DreamAgentRunner` contracts, and optional index retrieval consumes a host-supplied embedding provider.
