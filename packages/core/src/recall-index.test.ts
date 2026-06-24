import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildMemoryIndexSearchCache,
  hybridSearchMemoryIndex,
  parseMemoryIndexRecords,
  rrfFuse,
  type EmbeddingProvider,
} from "./recall-index.js";
import { makeRoot, cleanup } from "./test-helpers.js";

function providerWithVectors(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    async embed({ texts }) {
      return { vectors: texts.map((text) => vectors[text] ?? [0, 1]) };
    },
  };
}

test("parseMemoryIndexRecords uses stable path identity and embeds name description date plus retrieval terms", () => {
  const index = [
    "- [PR Discipline](workflow/pr-discipline.md) - Repo changes must go through pull requests. (type: workflow, path: workflow/pr-discipline.md, occurred_on: 2026-06-24, terms: review; pull request)",
    "- [User Style](style/user-style.md) - User prefers direct Chinese tables. (type: style, path: style/user-style.md)",
  ].join("\n");

  const records = parseMemoryIndexRecords(index);

  assert.deepEqual(records.map((record) => record.path), [
    "workflow/pr-discipline.md",
    "style/user-style.md",
  ]);
  assert.deepEqual(records.map((record) => record.lineId), ["L0001", "L0002"]);
  assert.equal(records[0]?.cacheKey, "workflow/pr-discipline.md");
  assert.deepEqual(records[0]?.retrievalTerms, ["review", "pull request"]);
  assert.equal(
    records[0]?.embedText,
    "PR Discipline\nRepo changes must go through pull requests.\n2026-06-24\nreview\npull request",
  );
  assert.ok(!records[0]?.embedText.includes("type:"));
  assert.ok(!records[0]?.embedText.includes("path:"));
});

test("buildMemoryIndexSearchCache reuses vectors by path when line ids shift", async () => {
  const root = await makeRoot();
  try {
    const cacheDir = path.join(root, ".memflywheel", "index");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, "memory-index.json"),
      JSON.stringify({
        version: 1,
        model: "fake",
        entries: [
          {
            path: "workflow/pr-discipline.md",
            lineHash: "old-hash",
            vector: [1, 0],
          },
        ],
      }),
    );

    const records = parseMemoryIndexRecords(
      [
        "- [New Top](context/new.md) - New entry. (type: context, path: context/new.md)",
        "- [PR Discipline](workflow/pr-discipline.md) - Repo changes must go through pull requests. (type: workflow, path: workflow/pr-discipline.md)",
      ].join("\n"),
    );
    const embedded: string[] = [];
    const provider: EmbeddingProvider = {
      async embed({ texts }) {
        embedded.push(...texts);
        return { vectors: texts.map(() => [0, 1]) };
      },
    };

    const cache = await buildMemoryIndexSearchCache({
      root,
      records,
      embeddingProvider: provider,
      model: "fake",
    });

    assert.deepEqual(
      embedded,
      [
        "New Top\nNew entry.",
        "PR Discipline\nRepo changes must go through pull requests.",
      ],
    );
    assert.equal(cache.vectors.get("workflow/pr-discipline.md")?.length, 2);

    const raw = JSON.parse(await readFile(path.join(cacheDir, "memory-index.json"), "utf8")) as {
      entries: Array<{ path: string }>;
    };
    assert.deepEqual(raw.entries.map((entry) => entry.path).sort(), [
      "context/new.md",
      "workflow/pr-discipline.md",
    ]);
  } finally {
    await cleanup(root);
  }
});

test("buildMemoryIndexSearchCache reuses unchanged path vectors even when line ids move", async () => {
  const root = await makeRoot();
  try {
    const records = parseMemoryIndexRecords(
      "- [PR Discipline](workflow/pr-discipline.md) - Repo changes must go through pull requests. (type: workflow, path: workflow/pr-discipline.md)",
    );
    let calls = 0;
    const provider: EmbeddingProvider = {
      async embed({ texts }) {
        calls += texts.length;
        return { vectors: texts.map(() => [1, 0]) };
      },
    };
    await buildMemoryIndexSearchCache({ root, records, embeddingProvider: provider, model: "fake" });

    const shifted = parseMemoryIndexRecords(
      [
        "- [Other](context/other.md) - Other entry. (type: context, path: context/other.md)",
        "- [PR Discipline](workflow/pr-discipline.md) - Repo changes must go through pull requests. (type: workflow, path: workflow/pr-discipline.md)",
      ].join("\n"),
    );
    await buildMemoryIndexSearchCache({ root, records: shifted, embeddingProvider: provider, model: "fake" });

    assert.equal(calls, 2, "only the new path is embedded on the second build");
  } finally {
    await cleanup(root);
  }
});

test("rrfFuse keeps dense and bm25 ranks independent of raw scores", () => {
  assert.deepEqual(
    rrfFuse(
      [
        { path: "a.md", rank: 1 },
        { path: "b.md", rank: 2 },
      ],
      [{ path: "b.md", rank: 1 }],
    ).map((row) => row.path),
    ["b.md", "a.md"],
  );
});

test("hybridSearchMemoryIndex returns top records without a no-result branch", async () => {
  const records = parseMemoryIndexRecords(
    [
      "- [Release PR Discipline](workflow/pr.md) - Changes must go through pull requests. (type: workflow, path: workflow/pr.md)",
      "- [Tea Preference](preference/tea.md) - User drinks green tea. (type: preference, path: preference/tea.md)",
    ].join("\n"),
  );
  const provider = providerWithVectors({
    "repo pr": [1, 0],
    "Release PR Discipline\nChanges must go through pull requests.": [1, 0],
    "Tea Preference\nUser drinks green tea.": [0, 1],
  });
  const cache = {
    records,
    vectors: new Map(records.map((record) => [record.path, providerWithVectors({})])),
  };
  // Replace the vectors with stable hand-authored values; the shape above is
  // intentionally not accepted by TypeScript if the cache contract drifts.
  const vectors = new Map<string, number[]>([
    ["workflow/pr.md", [1, 0]],
    ["preference/tea.md", [0, 1]],
  ]);

  const results = await hybridSearchMemoryIndex({
    query: "repo pr",
    records,
    vectors,
    embeddingProvider: provider,
    limit: 2,
  });

  assert.deepEqual(results.map((record) => record.path), ["workflow/pr.md", "preference/tea.md"]);
});

test("hybridSearchMemoryIndex ignores zero-score BM25 rows instead of letting path order override dense rank", async () => {
  const records = parseMemoryIndexRecords(
    [
      "- [Location](ambient/location.md) - User is based in Hefei. (type: ambient, path: ambient/location.md)",
      "- [Reply Language](preference/language.md) - User prefers replies in Chinese. (type: preference, path: preference/language.md)",
    ].join("\n"),
  );
  const provider = providerWithVectors({
    "回复用户应该用哪种语言？": [1, 0],
    "Location\nUser is based in Hefei.": [0.99, 0.01],
    "Reply Language\nUser prefers replies in Chinese.": [1, 0],
  });
  const vectors = new Map<string, number[]>([
    ["ambient/location.md", [0.99, 0.01]],
    ["preference/language.md", [1, 0]],
  ]);

  const results = await hybridSearchMemoryIndex({
    query: "回复用户应该用哪种语言？",
    records,
    vectors,
    embeddingProvider: provider,
    limit: 1,
  });

  assert.deepEqual(results.map((record) => record.path), ["preference/language.md"]);
});
