import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { INDEX_FILE } from "./index-file.js";

export interface EmbeddingProvider {
  embed(input: { texts: string[]; signal?: AbortSignal }): Promise<{ vectors: number[][] }>;
}

export interface MemoryIndexRecord {
  lineId: string;
  cacheKey: string;
  lineHash: string;
  rawLine: string;
  path: string;
  name: string;
  description: string;
  type?: string;
  occurred_on?: string;
  retrievalTerms: string[];
  embedText: string;
  bm25Text: string;
}

export interface MemoryIndexSearchCache {
  records: MemoryIndexRecord[];
  vectors: Map<string, number[]>;
}

export interface RankedPath {
  path: string;
  rank: number;
}

interface DiskCache {
  version: 1;
  model: string;
  entries: Array<{
    path: string;
    lineHash: string;
    vector: number[];
  }>;
}

const CACHE_DIR = ".memflywheel/index";
const CACHE_FILE = "memory-index.json";
const RRF_K = 60;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clean(value: string | undefined): string {
  return String(value ?? "").trim();
}

function lineId(index: number): string {
  return `L${String(index + 1).padStart(4, "0")}`;
}

export function parseMemoryIndexRecords(indexContent: string): MemoryIndexRecord[] {
  const records: MemoryIndexRecord[] = [];
  const lines = indexContent.split(/\r?\n/);

  for (const raw of lines) {
    const rawLine = raw.trim();
    if (!rawLine.startsWith("- [")) continue;

    const match = rawLine.match(/^- \[(?<name>[^\]]+)\]\((?<href>[^)]+)\) - (?<description>.*?)(?: \((?<meta>[^)]*)\))?$/u);
    if (!match?.groups) continue;

    const meta = match.groups.meta ?? "";
    const pathMatch = meta.match(/(?:^|,\s*)path:\s*([^,]+)(?:,|$)/u);
    const typeMatch = meta.match(/(?:^|,\s*)type:\s*([^,]+)(?:,|$)/u);
    const occurredMatch = meta.match(/(?:^|,\s*)occurred_on:\s*([^,]+)(?:,|$)/u);
    const termsMatch = meta.match(/(?:^|,\s*)terms:\s*([^)]*?)(?:,\s*\w+:|$)/u);
    const memoryPath = clean(pathMatch?.[1] ?? match.groups.href);
    if (!memoryPath) continue;

    const name = clean(match.groups.name);
    const description = clean(match.groups.description);
    const type = clean(typeMatch?.[1]) || undefined;
    const occurred_on = clean(occurredMatch?.[1]) || undefined;
    const retrievalTerms = clean(termsMatch?.[1])
      .split(";")
      .map((term) => clean(term))
      .filter(Boolean);
    const embedText = [name, description, occurred_on, ...retrievalTerms].filter(Boolean).join("\n");
    const bm25Text = [name, description, type, occurred_on, memoryPath, ...retrievalTerms].filter(Boolean).join(" ");

    records.push({
      lineId: lineId(records.length),
      cacheKey: memoryPath,
      lineHash: sha256(rawLine),
      rawLine,
      path: memoryPath,
      name,
      description,
      type,
      occurred_on,
      retrievalTerms,
      embedText,
      bm25Text,
    });
  }

  return records;
}

async function readDiskCache(root: string, model: string): Promise<Map<string, { lineHash: string; vector: number[] }>> {
  try {
    const raw = await readFile(path.join(root, CACHE_DIR, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as DiskCache;
    if (parsed.version !== 1 || parsed.model !== model || !Array.isArray(parsed.entries)) return new Map();
    return new Map(parsed.entries.map((entry) => [entry.path, { lineHash: entry.lineHash, vector: entry.vector }]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

async function writeDiskCache(root: string, model: string, entries: DiskCache["entries"]): Promise<void> {
  const dir = path.join(root, CACHE_DIR);
  await mkdir(dir, { recursive: true });
  const payload: DiskCache = { version: 1, model, entries };
  await writeFile(path.join(dir, CACHE_FILE), `${JSON.stringify(payload)}\n`, "utf8");
}

export async function buildMemoryIndexSearchCache(input: {
  root: string;
  records: MemoryIndexRecord[];
  embeddingProvider: EmbeddingProvider;
  model: string;
  signal?: AbortSignal;
}): Promise<MemoryIndexSearchCache> {
  const previous = await readDiskCache(input.root, input.model);
  const vectors = new Map<string, number[]>();
  const missing: MemoryIndexRecord[] = [];

  for (const record of input.records) {
    const cached = previous.get(record.path);
    if (cached && cached.lineHash === record.lineHash && Array.isArray(cached.vector)) {
      vectors.set(record.path, cached.vector);
    } else {
      missing.push(record);
    }
  }

  if (missing.length > 0) {
    const embedded = await input.embeddingProvider.embed({
      texts: missing.map((record) => record.embedText),
      signal: input.signal,
    });
    if (!Array.isArray(embedded.vectors) || embedded.vectors.length !== missing.length) {
      throw new Error("Memory index embedding provider returned an invalid vector count.");
    }
    missing.forEach((record, index) => {
      const vector = embedded.vectors[index];
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(`Memory index embedding provider returned an invalid vector for ${record.path}.`);
      }
      vectors.set(record.path, vector);
    });
  }

  await writeDiskCache(
    input.root,
    input.model,
    input.records.map((record) => ({
      path: record.path,
      lineHash: record.lineHash,
      vector: vectors.get(record.path) ?? [],
    })),
  );

  return { records: input.records, vectors };
}

function tokenize(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/[a-z0-9_./:-]+|[\p{Script=Han}]/gu), (m) => m[0]);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    a2 += av * av;
    b2 += bv * bv;
  }
  if (a2 === 0 || b2 === 0) return 0;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

function denseRank(records: MemoryIndexRecord[], vectors: Map<string, number[]>, queryVector: number[], topK: number): RankedPath[] {
  return records
    .map((record) => ({ path: record.path, score: cosine(vectors.get(record.path) ?? [], queryVector) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, topK)
    .map((row, index) => ({ path: row.path, rank: index + 1 }));
}

function bm25Rank(records: MemoryIndexRecord[], query: string, topK: number): RankedPath[] {
  const docs = records.map((record) => tokenize(record.bm25Text));
  const queryTokens = Array.from(new Set(tokenize(query)));
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  return records
    .map((record, index) => {
      const doc = docs[index] ?? [];
      const tf = new Map<string, number>();
      for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const freq = tf.get(token) ?? 0;
        if (freq === 0) continue;
        const idf = Math.log(1 + (records.length - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
        score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.length / Math.max(avgdl, 1)))));
      }
      return { path: record.path, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, topK)
    .map((row, index) => ({ path: row.path, rank: index + 1 }));
}

export function rrfFuse(...rankings: RankedPath[][]): RankedPath[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const row of ranking) {
      scores.set(row.path, (scores.get(row.path) ?? 0) + 1 / (RRF_K + row.rank));
    }
  }
  return Array.from(scores, ([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((row, index) => ({ path: row.path, rank: index + 1 }));
}

export async function hybridSearchMemoryIndex(input: {
  query: string;
  records: MemoryIndexRecord[];
  vectors: Map<string, number[]>;
  embeddingProvider: EmbeddingProvider;
  limit: number;
  denseTopK?: number;
  bm25TopK?: number;
  signal?: AbortSignal;
}): Promise<MemoryIndexRecord[]> {
  if (input.records.length === 0) return [];
  const queryEmbedding = await input.embeddingProvider.embed({ texts: [input.query], signal: input.signal });
  const queryVector = queryEmbedding.vectors[0];
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    throw new Error("Memory index embedding provider returned an invalid query vector.");
  }

  const dense = denseRank(input.records, input.vectors, queryVector, input.denseTopK ?? 80);
  const sparse = bm25Rank(input.records, input.query, input.bm25TopK ?? 80);
  const fused = rrfFuse(dense, sparse).slice(0, input.limit);
  const byPath = new Map(input.records.map((record) => [record.path, record]));
  return fused.map((row) => byPath.get(row.path)).filter((record): record is MemoryIndexRecord => Boolean(record));
}

export function buildRelevantMemoryIndexPrompt(records: MemoryIndexRecord[], indexPath = INDEX_FILE): string {
  const lines = records.map((record) => record.rawLine).join("\n");
  return `<system-reminder>\n## 相关记忆条目\n\n以下条目是系统从 MEMORY.md 索引中通过混合检索得到的相关路径线索。它们不是完整事实；需要时读取对应文件。\n\n${lines}\n\n## 全局记忆索引\n\n如果相关条目不足，可以读取完整索引文件：\n\n${indexPath}\n</system-reminder>`;
}
