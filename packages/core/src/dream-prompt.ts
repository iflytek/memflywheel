/**
 * Default dream-consolidation subagent prompt + seed user-message builder
 * (pure; no LLM, no I/O).
 *
 * Mirrors the extraction defaults: a self-contained tool-use system prompt plus
 * a builder that renders the structural packets (index / manifest / health /
 * type-review) into the seed user message. The SDK drives this through the same
 * tool-calling loop the extraction subagent uses; core never calls an LLM. The
 * consolidation subagent writes by calling the memory tools directly — there is
 * no JSON op format to parse, and "nothing to consolidate" is simply making no
 * tool calls.
 */

import { type HealthFinding, type TypeReviewItem } from "./health.js";
import { type DreamCoordination } from "./dream.js";

/**
 * The default dream-consolidation system prompt. Self-contained English. Covers:
 * how dream differs from extraction; the tools and the locate → read → write
 * contract; the read-before-merge rule (never author a merged body from an
 * excerpt); structural health codes; judging true semantic type; edit priority
 * (fix > supplement > create > delete, prefer update over create); minimal
 * change and frontmatter-as-protocol; compress-to-trigger semantics for the
 * coordination directive; and the per-type consolidation rules.
 */
export const DEFAULT_DREAM_SYSTEM_PROMPT = `You are a long-term memory consolidation engine ("dream"). Your job is to keep the memory store structurally healthy and semantically correct by editing files through the provided tools. The tool calls ARE the changes — there is no separate report to produce.

# Dream is not extraction

Extraction incrementally captures new signals from a recent conversation. Dream reviews the WHOLE store: structure health, semantic-type verification, deduplication, compression, and retirement of obsolete or conflicting memories.

# Tools (the only way to change anything)

- memory_list — list memories (optionally by type). Read-only.
- memory_search — find same-topic memories by keyword over name/description/body. Read-only.
- memory_read — read ONE memory's full frontmatter + body by path. Read-only.
- memory_save — create one consolidated memory (type, single-line name, optional description, 1–4 sentence body).
- memory_update — replace an existing memory's body (and optionally name/description) by path; type is fixed by the path.
- memory_archive — retire one memory by path.

# The contract: locate → READ FULL BODIES → write

You receive packets (index, manifest, health findings, per-file type review with a body EXCERPT). The excerpts are only a map. Before you merge or compress anything, memory_read each file you will touch and work from its REAL full body. Never author a merged or compressed body from an excerpt — you will silently drop whatever the excerpt cut off.

- To merge near-duplicates: memory_read every source in full, memory_save ONE consolidated memory that preserves every distinct fact, then memory_archive each source you folded in.
- To fix a wrong type (invalid-frontmatter-type / path-type-mismatch): judge the true type from the full body, memory_save it under the correct type, then memory_archive the misplaced file. Do not blindly delete a misfiled memory.
- To compress an over-long memory: memory_read it, then memory_update with a short body — keep the durable signal, drop step-by-step detail.

# Edit priority and minimal change

Fix > supplement > create > delete. Always prefer updating an existing typed file over creating a near-duplicate. Make minimal changes. Frontmatter is protocol, not a summary: preserve name / description / type unless you are deliberately fixing a frontmatter error. Never mix "fix structure" and "rewrite content" in one step.

# Coordination directive

If a coordination directive sets memoryAction to compress-memory for a topic, the matching memory must keep only a short routing cue toward the target skill — never execution steps. Preserve its name / description / type. Never read, rewrite, or guess skill content; never write skill execution steps back into memory.

# Per-type consolidation rules

- identity: keep only the user's own stable identity; do not fold ambient / context / preference into identity.
- ambient: long-term surrounding info (team member roles, external contacts, organizations that recurrently influence collaboration).
- style / workflow: keep brief signals or summaries; a complete numbered method belongs in a skill, so compress or remove it from memory.
- preference: list-type preferences group by topic; when merging, keep every listed item.
- context: fixed terms and naming / project conventions.

# Privacy

Never write secrets (keys, tokens, full card / account numbers, passwords) into memory, even while consolidating.

# When nothing needs consolidation

If the store is already healthy and correct, make NO tool calls and stop.`;

/** Render the structural packets (plus optional coordination) as the seed user message. */
export function buildDreamAgentUserMessage(input: {
  health: HealthFinding[];
  typeReview: TypeReviewItem[];
  manifest: string;
  index: string;
  coordination?: DreamCoordination;
}): string {
  const lines: string[] = [];

  lines.push("# Memory index (MEMORY.md)");
  lines.push("");
  lines.push(input.index.trim() || "(empty)");
  lines.push("");

  lines.push("# Manifest");
  lines.push("");
  lines.push(input.manifest.trim() || "(none)");
  lines.push("");

  lines.push("# Health findings");
  lines.push("");
  if (input.health.length === 0) {
    lines.push("(none)");
  } else {
    for (const finding of input.health) {
      lines.push(`- [${finding.severity}] ${finding.code}: ${finding.paths.join(", ")} — ${finding.message}`);
    }
  }
  lines.push("");

  lines.push("# Type review (excerpts only — memory_read the full body before editing)");
  lines.push("");
  if (input.typeReview.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of input.typeReview) {
      lines.push(`- ${item.path} (type=${item.type}, name=${item.name}): ${item.excerpt}`);
    }
  }
  lines.push("");

  if (input.coordination) {
    lines.push("# Coordination directive");
    lines.push("");
    lines.push(`- reason: ${input.coordination.reason}`);
    lines.push(`- memoryAction: ${input.coordination.memoryAction}`);
    lines.push(`- topics: ${input.coordination.topics.join(", ")}`);
    lines.push("");
  }

  lines.push(
    "Consolidate the store with the memory tools. Read full bodies before merging or compressing. Make no tool calls if the store is already healthy.",
  );
  return lines.join("\n");
}
