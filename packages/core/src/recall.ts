/**
 * Two-segment recall injection — MemScribe's clean equivalent of the reference
 * knowledge-layer build() recall path. Full-index, no retrieval.
 *
 * Segment 1 (systemPrompt): STABLE memory rules → cache-friendly prefix.
 * Segment 2 (preludePrompt): DYNAMIC full MEMORY.md index in <system-reminder>.
 */

import { scanMemoryFiles } from "./scan.js";
import {
  syncMemoryIndex,
  readMemoryIndex,
  truncateIndex,
  applyAgingHints,
} from "./index-file.js";

export interface BuildContextResult {
  systemPrompt: string;
  preludePrompt: string;
  enabled: boolean;
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
 *   → systemPrompt = rules, preludePrompt = <system-reminder> full index.
 * When enabled is false, returns empty strings and performs no scan/inject.
 */
export async function buildContext(opts: {
  root: string;
  enabled?: boolean;
}): Promise<BuildContextResult> {
  const enabled = opts.enabled !== false;
  if (!enabled) {
    return { systemPrompt: "", preludePrompt: "", enabled: false };
  }

  const entries = await scanMemoryFiles(opts.root);
  await syncMemoryIndex(opts.root, entries);
  const rawIndex = await readMemoryIndex(opts.root);
  const truncated = truncateIndex(rawIndex);
  const hinted = applyAgingHints(truncated, entries);

  return {
    systemPrompt: buildMemoryInstructionPrompt(),
    preludePrompt: buildMemoryIndexPrompt(hinted),
    enabled: true,
  };
}
