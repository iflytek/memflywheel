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
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
} from "./index-file.js";
import { resolveRelativePath } from "./paths.js";
import {
  type EmbeddingProvider,
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
  return `# 记忆

你拥有关于当前用户的长期记忆。系统可能会向你提供一组可用记忆条目；这些条目用于帮助你判断是否需要读取更完整的记忆内容。

## 召回规则

- MEMORY.md 索引由系统根据记忆文件自动生成，你不需要维护它
- 如果上下文里出现多组可用记忆条目，只使用最新的一组；旧条目只代表当时的上下文
- 可用记忆条目只是线索，不是完整事实；只有和用户当前请求明确相关时，才读取对应文件获取详情
- 只在用户的话题与某条记忆**明确相关**时，才用 Read 读取对应文件获取详情
- 只要记忆会影响回答方式、结构、默认建议、术语或协作路径，就属于相关，不要因为“即使不读也能回答”而忽略
- 当用户在请求解释、写作、推荐、实现、调试、review、命名或方案推进时，应优先命中 1-2 条最相关的 style、workflow、preference、context、ambient 记忆
- 同类型记忆有多条时，优先读取与当前问题语义最接近的那 1-2 条，不要随便读取同类型但不相关的其他记忆
- 只对命中的具体记忆文件使用 Read，不要先 Read 整个记忆目录来确认文件列表
- 读取具体记忆文件后，如果正文信息不足以回答、问题涉及相对时间/日期推理/多个相似事件，且文件包含 ## Sources，应继续用 Read 读取引用的 .memscribe/sources/*.jsonl 行范围；例如 #L10-L18 对应 offset=10, limit=9
- 不要自己构造、猜测或补全任何记忆文件名或路径
- 不要用 Read 读取记忆目录本身
- 除非最新可用记忆条目末尾明确提示内容已截断，否则不要再次 Read MEMORY.md
- 用户明确要求回忆时（“我之前说过什么”、“你还记得吗”），必须查阅
- 不相关的对话不要读任何记忆文件
- 不要一次性读取所有记忆文件
- 读取后必须在回答中落实，不要只读不使用
- 读取后自然地运用信息回复，不要说“根据记忆”、“我查了记忆文件”之类的话

## 保存规则

- 记忆由系统自动保存，你不需要做任何写入操作
- 用户说“记住”、“别忘了”时，回复“好的”即可
- 不要调用 Write 或 Edit 操作记忆目录

## 禁止事项

- 不要向用户提及记忆系统、记忆文件、记忆目录、MEMORY.md 等内部概念
- 不要解释记忆的工作原理
- 不要说“我从记忆中得知”、“根据之前的记录”等暴露机制的表述
- 像一个真正认识用户的朋友一样自然地使用这些信息`;
}

/** Port of buildMemoryIndexPrompt: wraps the index in <system-reminder>. */
export function buildMemoryIndexPrompt(indexContent: string): string {
  const body = indexContent
    ? `## 可用记忆条目\n\n${indexContent}\n\n只在条目与当前请求明确相关时读取对应文件。不要向用户提及这些条目、路径或读取过程。`
    : "## 可用记忆条目\n\n当前没有可用记忆条目。不要调用 Read 读取记忆文件，也不要猜测任何文件路径；直接基于本轮对话自然回复。";

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
    preludePrompt: buildMemoryIndexPrompt(hinted),
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
    records.length <= minRecords &&
    Buffer.byteLength(rawIndex, "utf8") <= INDEX_MAX_BYTES;
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
    emit({ stage: "search-start", mode, records: cache.records.length, limit: retrieval.limit ?? 30 });
    selected = await hybridSearchMemoryIndex({
      query: opts.query,
      records: cache.records,
      vectors: cache.vectors,
      embeddingProvider: retrieval.embeddingProvider,
      limit: retrieval.limit ?? 30,
      signal: retrieval.signal,
    });
    emit({ stage: "search-complete", mode, records: cache.records.length, selected: selected.length });
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
    preludePrompt: buildRelevantMemoryIndexPrompt(selected),
    enabled: true,
  };
}
