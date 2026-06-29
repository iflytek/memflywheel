import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHealthFindings, buildTypeReviewPacket } from "./health.js";
import { makeRoot, cleanup, writeFixture, writeRaw } from "./test-helpers.js";

test("buildHealthFindings detects missing frontmatter and duplicates", async () => {
  const root = await makeRoot();
  try {
    await writeRaw(root, "context/broken.md", "no frontmatter at all");
    await writeFixture(root, "style", "a.md", { name: "同名", body: "same body", mtime: 1 });
    await writeFixture(root, "style", "b.md", { name: "同名", body: "same body", mtime: 2 });

    const findings = await buildHealthFindings(root);
    const codes = findings.map((f) => f.code);
    assert.ok(codes.includes("missing-frontmatter"));
    assert.ok(codes.includes("duplicate-name-type"));
    assert.ok(codes.includes("duplicate-content"));

    // Sorted: errors (lower order) before warns.
    assert.equal(findings[0]!.code, "missing-frontmatter");
  } finally {
    await cleanup(root);
  }
});

test("buildHealthFindings flags path-type-mismatch", async () => {
  const root = await makeRoot();
  try {
    // File lives in identity/ but declares type: preference.
    await writeRaw(root, "identity/wrong.md", "---\nname: 错位\ntype: preference\n---\n\n正文");
    const findings = await buildHealthFindings(root);
    assert.ok(findings.some((f) => f.code === "path-type-mismatch"));
  } finally {
    await cleanup(root);
  }
});

test("buildTypeReviewPacket returns sorted entries with excerpts", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "u.md", {
      name: "用户",
      description: "称呼",
      body: "叫小钟",
      mtime: 1,
    });
    const packet = await buildTypeReviewPacket(root);
    assert.equal(packet.length, 1);
    assert.equal(packet[0]!.path, "identity/u.md");
    assert.equal(packet[0]!.type, "identity");
    assert.ok(packet[0]!.excerpt.includes("叫小钟"));
  } finally {
    await cleanup(root);
  }
});
