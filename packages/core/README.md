# @memscribe/core

The MemScribe memory kernel: file-backed Markdown + YAML-frontmatter storage, derived `MEMORY.md` index, full-index recall (no retrieval), extraction and dream consolidation with pluggable LLM injection points, privacy redaction, per-root write locking, atomic writes, and an append-only audit log.

Zero runtime dependencies — Node stdlib + TypeScript only. The core never calls an LLM; extraction and dream consolidation are supplied by the host through the `ExtractionAgentRunner` and `DreamAgentRunner` contracts — both tool-calling subagents that write memory files via ordinary file tools.
