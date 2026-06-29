import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type EmbeddingProvider,
  type MemoryIndexRetrievalDiagnostic,
  buildContext,
  buildMemoryInstructionPrompt,
  buildMemoryIndexPrompt,
} from "./recall.js";
import { makeRoot, cleanup, writeFixture } from "./test-helpers.js";

function _fixedEmbeddingProvider(vector: number[]): EmbeddingProvider {
  return {
    async embed({ texts }) {
      return { vectors: texts.map(() => vector) };
    },
  };
}

function releaseEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed({ texts }) {
      return {
        vectors: texts.map((text) => (text.includes("发布") ? [1, 0] : [0, 1])),
      };
    },
  };
}

function needleEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed({ texts }) {
      return {
        vectors: texts.map((text) => (text.includes("rare-needle") ? [1, 0] : [0, 1])),
      };
    },
  };
}

test("buildMemoryInstructionPrompt is stable rules with no index", () => {
  const rules = buildMemoryInstructionPrompt();
  assert.ok(rules.includes("# 记忆"));
  assert.ok(rules.includes("召回规则"));
  assert.ok(rules.includes("## Sources"));
  assert.ok(rules.includes(".memflywheel/sources"));
  assert.ok(!rules.includes("<system-reminder>"));
});

test("buildMemoryIndexPrompt wraps index in system-reminder", () => {
  const withIndex = buildMemoryIndexPrompt("- [a](p) - d");
  assert.ok(withIndex.startsWith("<system-reminder>"));
  assert.ok(withIndex.includes("## 可用记忆条目"));
  assert.ok(withIndex.includes("- [a](p) - d"));
  assert.ok(withIndex.endsWith("</system-reminder>"));

  const empty = buildMemoryIndexPrompt("");
  assert.ok(empty.includes("当前没有可用记忆条目"));
});

test("buildContext returns two segments and full index", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "u.md", {
      name: "用户称呼",
      description: "称呼",
      body: "叫小钟",
      mtime: 1,
    });
    const result = await buildContext({ root });
    assert.equal(result.enabled, true);
    assert.ok(result.systemPrompt.includes("# 记忆"));
    assert.ok(result.preludePrompt.startsWith("<system-reminder>"));
    assert.ok(result.preludePrompt.includes("用户称呼"));
  } finally {
    await cleanup(root);
  }
});

test("buildContext disabled returns empty and does not scan", async () => {
  const result = await buildContext({ root: "/tmp/whatever", enabled: false });
  assert.deepEqual(result, { systemPrompt: "", preludePrompt: "", enabled: false });
});

test("buildContext uses hybrid index retrieval when a query and provider are available past the size gate", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "workflow", "release.md", {
      name: "发布流程",
      description: "pnpm build 后打 tag",
      body: "release",
      mtime: 1,
    });
    await writeFixture(root, "preference", "tea.md", {
      name: "饮茶偏好",
      description: "喜欢茉莉花茶",
      body: "tea",
      mtime: 2,
    });
    const diagnostics: MemoryIndexRetrievalDiagnostic[] = [];

    const result = await buildContext({
      root,
      query: "如何发布这个包",
      indexRetrieval: {
        embeddingProvider: releaseEmbeddingProvider(),
        minRecords: 1,
        limit: 1,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    });

    assert.ok(result.preludePrompt.includes("## 相关记忆条目"));
    assert.ok(result.preludePrompt.includes("发布流程"));
    assert.ok(!result.preludePrompt.includes("饮茶偏好"));
    assert.ok(result.preludePrompt.includes("MEMORY.md"));
    assert.deepEqual(
      diagnostics.find((event) => event.stage === "search-complete")?.selectedPaths,
      ["workflow/release.md"],
    );
  } finally {
    await cleanup(root);
  }
});

test("buildContext retrieves index entries beyond the prompt-manifest cap", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "workflow", "rare-needle.md", {
      name: "rare-needle workflow",
      description: "the old but relevant release ritual",
      body: "needle",
      mtime: 0,
    });
    for (let i = 0; i < 205; i += 1) {
      await writeFixture(root, "preference", `fresh-${i}.md`, {
        name: `fresh preference ${i}`,
        description: `recent unrelated preference ${i}`,
        body: `fresh ${i}`,
        mtime: 1000 + i,
      });
    }

    const result = await buildContext({
      root,
      query: "rare-needle",
      indexRetrieval: {
        embeddingProvider: needleEmbeddingProvider(),
        minRecords: 1,
        limit: 1,
      },
    });

    assert.ok(result.preludePrompt.includes("rare-needle workflow"));
  } finally {
    await cleanup(root);
  }
});

test("buildContext skips retrieval for small indexes that already fit full injection", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "workflow", "release.md", {
      name: "发布流程",
      description: "pnpm build 后打 tag",
      body: "release",
      mtime: 1,
    });
    let calls = 0;
    const provider: EmbeddingProvider = {
      async embed({ texts }) {
        calls += 1;
        return { vectors: texts.map(() => [1, 0]) };
      },
    };

    const result = await buildContext({
      root,
      query: "发布",
      indexRetrieval: { embeddingProvider: provider },
    });

    assert.equal(calls, 0);
    assert.ok(result.preludePrompt.includes("## 可用记忆条目"));
    assert.ok(result.preludePrompt.includes("发布流程"));
  } finally {
    await cleanup(root);
  }
});

test("buildContext falls back to full index when the embedding provider fails at runtime", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "workflow", "release.md", {
      name: "发布流程",
      description: "pnpm build 后打 tag",
      body: "release",
      mtime: 1,
    });
    await writeFixture(root, "preference", "tea.md", {
      name: "饮茶偏好",
      description: "喜欢茉莉花茶",
      body: "tea",
      mtime: 2,
    });
    const provider: EmbeddingProvider = {
      async embed() {
        throw new Error("embedding timeout");
      },
    };

    const result = await buildContext({
      root,
      query: "发布",
      indexRetrieval: { embeddingProvider: provider, minRecords: 1 },
    });

    assert.ok(result.preludePrompt.includes("## 可用记忆条目"));
    assert.ok(result.preludePrompt.includes("发布流程"));
    assert.ok(result.preludePrompt.includes("饮茶偏好"));
  } finally {
    await cleanup(root);
  }
});

test("buildContext required retrieval fails fast when no provider is configured", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "workflow", "release.md", {
      name: "发布流程",
      description: "pnpm build 后打 tag",
      body: "release",
      mtime: 1,
    });

    await assert.rejects(
      () =>
        buildContext({
          root,
          query: "发布",
          indexRetrieval: { mode: "required", minRecords: 0 },
        }),
      /requires an embedding provider/,
    );
  } finally {
    await cleanup(root);
  }
});
