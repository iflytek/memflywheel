import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scanAllMemoryFiles,
  scanMemoryFiles,
  readAllMemoryContents,
  formatManifest,
} from "./scan.js";
import { makeRoot, cleanup, writeFixture, writeRaw } from "./test-helpers.js";

test("scanMemoryFiles finds typed files, skips reserved/hidden/invalid", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "user-name.md", {
      name: "用户称呼",
      description: "称呼",
      retrievalTerms: ["nickname", "addressing user"],
      body: "叫小钟",
      mtime: 2000,
    });
    await writeFixture(root, "workflow", "debug.md", {
      name: "调试",
      body: "先看日志",
      mtime: 3000,
    });
    await writeRaw(root, "MEMORY.md", "- index line");
    await writeRaw(root, ".hidden.md", "ignored");
    await writeRaw(root, "context/broken.md", "no frontmatter here");

    const entries = await scanMemoryFiles(root);
    assert.equal(entries.length, 2);
    // Sorted by mtime DESC: workflow (3000) before identity (2000).
    assert.equal(entries[0]!.relativePath, "workflow/debug.md");
    assert.equal(entries[1]!.relativePath, "identity/user-name.md");
    assert.equal(entries[1]!.description, "称呼");
    assert.deepEqual(entries[1]!.retrievalTerms, ["nickname", "addressing user"]);
  } finally {
    await cleanup(root);
  }
});

test("scanMemoryFiles only scans typed memory directories", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "preference", "coffee.md", {
      name: "Coffee",
      description: "Drink preference",
      body: "Prefers iced americano.",
      mtime: 2000,
    });
    await writeRaw(
      root,
      "skills/memflywheel-learned-release-runbook/SKILL.md",
      [
        "---",
        "name: Release runbook",
        "description: Reusable release workflow",
        "---",
        "",
        "## Use Cases",
        "",
        "Release a package.",
      ].join("\n"),
    );

    const entries = await scanMemoryFiles(root);

    assert.deepEqual(
      entries.map((entry) => entry.relativePath),
      ["preference/coffee.md"],
    );
  } finally {
    await cleanup(root);
  }
});

test("scanMemoryFiles returns [] for missing root", async () => {
  const entries = await scanMemoryFiles("/tmp/does-not-exist-memflywheel-xyz");
  assert.deepEqual(entries, []);
});

test("scanAllMemoryFiles keeps the complete index corpus while scanMemoryFiles caps the prompt manifest", async () => {
  const root = await makeRoot();
  try {
    for (let i = 0; i < 205; i += 1) {
      await writeFixture(root, "workflow", `w-${i}.md`, {
        name: `workflow ${i}`,
        description: `desc ${i}`,
        body: `body ${i}`,
        mtime: i,
      });
    }

    const manifestEntries = await scanMemoryFiles(root);
    const indexEntries = await scanAllMemoryFiles(root);

    assert.equal(manifestEntries.length, 200);
    assert.equal(indexEntries.length, 205);
    assert.equal(indexEntries.at(-1)?.relativePath, "workflow/w-0.md");
  } finally {
    await cleanup(root);
  }
});

test("readAllMemoryContents concatenates bodies", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "n.md", { name: "Name", body: "body one", mtime: 1000 });
    const out = await readAllMemoryContents(root);
    assert.ok(out.includes("### Name (identity)"));
    assert.ok(out.includes("body one"));
  } finally {
    await cleanup(root);
  }
});

test("formatManifest renders lines or empty marker", () => {
  assert.equal(formatManifest([]), "（无现有记忆）");
  const line = formatManifest([
    {
      filename: "u.md",
      relativePath: "identity/u.md",
      name: "n",
      description: "d",
      type: "identity",
      mtime: 0,
    },
  ]);
  assert.ok(line.startsWith("- [identity] identity/u.md ("));
  assert.ok(line.endsWith("): d"));
});
