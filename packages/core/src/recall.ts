/**
 * Two-segment recall injection.
 *
 * Segment 1 (systemPrompt): STABLE memory rules → cache-friendly prefix.
 * Segment 2 (preludePrompt): DYNAMIC index cues in <system-reminder>.
 */

import { scanAllMemoryFiles } from "./scan.js";
import { stat } from "node:fs/promises";
import {
  syncMemoryIndex,
  readMemoryIndex,
  truncateIndex,
  applyAgingHints,
  INDEX_FILE,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
} from "./index-file.js";
import { resolveRelativePath } from "./paths.js";
import {
  type EmbeddingProvider,
  absolutizeMemoryIndexContent,
  buildMemoryIndexSearchCache,
  buildRelevantMemoryIndexPrompt,
  hybridSearchMemoryIndex,
  parseMemoryIndexRecords,
} from "./recall-index.js";

export type { EmbeddingProvider } from "./recall-index.js";

export interface BuildContextResult {
  systemPrompt: string;
  preludePrompt: string;
  enabled: boolean;
}

export type MemoryIndexRetrievalMode = "auto" | "off" | "required";

export interface MemoryIndexRetrievalDiagnostic {
  stage:
    | "skip"
    | "records"
    | "cache-start"
    | "cache-complete"
    | "search-start"
    | "search-complete"
    | "fallback";
  reason?: string;
  mode?: MemoryIndexRetrievalMode;
  records?: number;
  selected?: number;
  selectedLineIds?: string[];
  selectedPaths?: string[];
  bytes?: number;
  limit?: number;
  minRecords?: number;
  errorName?: string;
  errorMessage?: string;
  errorCauseName?: string;
  errorCauseCode?: string;
  errorCauseMessage?: string;
}

export interface MemoryIndexRetrievalOptions {
  mode?: MemoryIndexRetrievalMode;
  embeddingProvider?: EmbeddingProvider;
  model?: string;
  limit?: number;
  minRecords?: number;
  signal?: AbortSignal;
  onDiagnostic?: (event: MemoryIndexRetrievalDiagnostic) => void;
}

/** Stable memory rules. Port of buildMemoryInstructionPrompt. */
export function buildMemoryInstructionPrompt(): string {
  return `# Memory

You have long-term memory about the current user. The system may provide available memory entries as routing hints for deciding whether to read more detailed memory content.

## Recall Rules

- MEMORY.md is generated automatically from memory files; do not maintain it manually.
- If multiple available-memory blocks appear in context, use only the latest one; older blocks only reflect earlier context.
- Available memory entries are hints, not complete facts. Read a memory file only when it is clearly relevant to the current user request.
- Read a specific memory file only when the user's topic is clearly related to that entry.
- A memory is relevant when it may affect response style, structure, default suggestions, terminology, or collaboration path. Do not ignore it merely because you could answer without reading it.
- For explanation, writing, recommendation, implementation, debugging, review, naming, or planning requests, prefer the 1-2 most relevant style, workflow, preference, context, or ambient memories.
- When multiple memories of the same type exist, prefer the 1-2 semantically closest files. Do not read unrelated files of the same type.
- Read only the specific matched memory files. Do not read the whole memory directory to discover files.
- After reading a memory file, if the body is insufficient and the question involves relative time, date reasoning, or similar events, and the file has ## Sources, read the referenced absolute source trace line range, for example #L10-L18 as offset=10, limit=9.
- Do not construct, guess, or complete memory file names or paths yourself.
- Do not use Read on the memory directory itself.
- Do not read MEMORY.md again unless the latest available-memory block explicitly says it was truncated.
- When the user explicitly asks you to recall something, you must inspect the relevant memory.
- Do not read memory files for unrelated conversation.
- Do not read all memory files at once.
- If you read memory, use it in the answer. Do not read and then ignore it.
- Use memory naturally. Do not say "according to memory", "I checked a memory file", or similar mechanism-revealing phrases.

## Save Rules

- Memory is saved automatically by the system. You do not need to write memory yourself.
- If the user says "remember this" or "do not forget", simply acknowledge it.
- Do not call Write or Edit on the memory directory.

## Forbidden

- Do not mention memory-system internals, memory files, memory directories, or MEMORY.md to the user.
- Do not explain how memory works.
- Do not say "I know from memory", "according to earlier records", or similar mechanism-revealing phrases.
- Use the information naturally, as if you genuinely know the user.`;
}

/** Port of buildMemoryIndexPrompt: wraps the index in <system-reminder>. */
export function buildMemoryIndexPrompt(indexContent: string): string {
  const body = indexContent
    ? `## Available Memory Entries\n\n${indexContent}\n\nRead a listed file only when the entry is clearly relevant to the current request. Do not mention these entries, paths, or the reading process to the user.`
    : "## Available Memory Entries\n\nNo memory entries are currently available. Do not call Read on memory files or guess file paths; respond naturally from the current conversation.";

  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * Deterministic recall pipeline (no LLM):
 *   scan → syncIndex → readIndex → truncate → aging
 *   → systemPrompt = rules, preludePrompt = <system-reminder> index cues.
 * When enabled is false, returns empty strings and performs no scan/inject.
 */
export async function buildContext(opts: {
  root: string;
  enabled?: boolean;
  query?: string;
  indexRetrieval?: MemoryIndexRetrievalOptions;
}): Promise<BuildContextResult> {
  const enabled = opts.enabled !== false;
  if (!enabled) {
    return { systemPrompt: "", preludePrompt: "", enabled: false };
  }

  const entries = await scanAllMemoryFiles(opts.root);
  await syncMemoryIndex(opts.root, entries);
  const rawIndex = await readMemoryIndex(opts.root);
  const truncated = truncateIndex(rawIndex);
  const hinted = applyAgingHints(truncated, entries);
  const fallback: BuildContextResult = {
    systemPrompt: buildMemoryInstructionPrompt(),
    preludePrompt: buildMemoryIndexPrompt(absolutizeMemoryIndexContent(hinted, opts.root)),
    enabled: true,
  };

  const retrieval = opts.indexRetrieval;
  const mode = retrieval?.mode ?? "auto";
  if (!retrieval) return fallback;
  const emit = (event: MemoryIndexRetrievalDiagnostic): void => {
    retrieval.onDiagnostic?.(event);
  };
  if (mode === "off") {
    emit({ stage: "skip", reason: "mode-off", mode });
    return fallback;
  }
  if (!opts.query?.trim()) {
    emit({ stage: "skip", reason: "missing-query", mode });
    return fallback;
  }

  if (!retrieval.embeddingProvider) {
    emit({ stage: "skip", reason: "missing-embedding-provider", mode });
    if (mode === "required") {
      throw new Error("Memory index retrieval requires an embedding provider.");
    }
    return fallback;
  }

  const records = parseMemoryIndexRecords(rawIndex);
  const minRecords = retrieval.minRecords ?? INDEX_MAX_LINES;
  emit({
    stage: "records",
    mode,
    records: records.length,
    bytes: Buffer.byteLength(rawIndex, "utf8"),
    limit: retrieval.limit ?? 30,
    minRecords,
  });
  const fitsFullIndex =
    records.length <= minRecords && Buffer.byteLength(rawIndex, "utf8") <= INDEX_MAX_BYTES;
  if (fitsFullIndex) {
    emit({
      stage: "skip",
      reason: "full-index-fits",
      mode,
      records: records.length,
      bytes: Buffer.byteLength(rawIndex, "utf8"),
      minRecords,
    });
    return fallback;
  }

  let selected = records;
  let stage: MemoryIndexRetrievalDiagnostic["stage"] = "cache-start";
  try {
    emit({ stage: "cache-start", mode, records: records.length });
    const cache = await buildMemoryIndexSearchCache({
      root: opts.root,
      records,
      embeddingProvider: retrieval.embeddingProvider,
      model: retrieval.model ?? "default",
      signal: retrieval.signal,
    });
    emit({ stage: "cache-complete", mode, records: cache.records.length });
    stage = "search-start";
    emit({
      stage: "search-start",
      mode,
      records: cache.records.length,
      limit: retrieval.limit ?? 30,
    });
    selected = await hybridSearchMemoryIndex({
      query: opts.query,
      records: cache.records,
      vectors: cache.vectors,
      embeddingProvider: retrieval.embeddingProvider,
      limit: retrieval.limit ?? 30,
      signal: retrieval.signal,
    });
    emit({
      stage: "search-complete",
      mode,
      records: cache.records.length,
      selected: selected.length,
      selectedLineIds: selected.map((record) => record.lineId),
      selectedPaths: selected.map((record) => record.path),
    });
  } catch (error) {
    const cause =
      error instanceof Error && typeof error.cause === "object" && error.cause !== null
        ? (error.cause as { name?: unknown; code?: unknown; message?: unknown })
        : undefined;
    emit({
      stage: "fallback",
      reason: stage,
      mode,
      records: records.length,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorCauseName: typeof cause?.name === "string" ? cause.name : undefined,
      errorCauseCode: typeof cause?.code === "string" ? cause.code : undefined,
      errorCauseMessage: typeof cause?.message === "string" ? cause.message : undefined,
    });
    return fallback;
  }

  for (const record of selected) {
    const abs = resolveRelativePath(opts.root, record.path);
    if (!abs) {
      throw new Error(`Memory index retrieval selected an invalid path: ${record.path}`);
    }
    await stat(abs);
  }

  return {
    systemPrompt: buildMemoryInstructionPrompt(),
    preludePrompt: buildRelevantMemoryIndexPrompt(
      selected,
      resolveRelativePath(opts.root, INDEX_FILE) ?? INDEX_FILE,
      opts.root,
    ),
    enabled: true,
  };
}
