import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type StorageContext,
  readMemoryDocument,
  writeMemoryDocument,
  deleteMemoryDocument,
  archiveMemoryDocument,
  InvalidMemoryError,
} from "./storage.js";
import { SecretRefusedError } from "./privacy.js";
import { createNullAuditLogger } from "./audit.js";
import { makeRoot, cleanup } from "./test-helpers.js";

function ctxFor(root: string): StorageContext {
  return { root, audit: createNullAuditLogger() };
}

test("writeMemoryDocument stamps timestamps and preserves created_at", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const rel = await writeMemoryDocument(ctx, {
      type: "identity",
      filename: "user-name.md",
      doc: { frontmatter: { name: "用户称呼", description: "称呼", type: "identity" }, body: "叫小钟" },
    });
    assert.equal(rel, "identity/user-name.md");

    const first = await readMemoryDocument(ctx, rel);
    assert.ok(first?.frontmatter.created_at);
    const createdAt = first!.frontmatter.created_at;

    await new Promise((r) => setTimeout(r, 5));
    await writeMemoryDocument(ctx, {
      type: "identity",
      filename: "user-name.md",
      doc: { frontmatter: { name: "用户称呼", description: "新称呼", type: "identity" }, body: "叫小钟2" },
    });
    const second = await readMemoryDocument(ctx, rel);
    assert.equal(second?.frontmatter.created_at, createdAt);
    assert.notEqual(second?.frontmatter.updated_at, createdAt);
    assert.equal(second?.body, "叫小钟2");
  } finally {
    await cleanup(root);
  }
});

test("writeMemoryDocument preserves model-authored occurred_on alongside write times", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const rel = await writeMemoryDocument(ctx, {
      type: "context",
      filename: "team-reorg.md",
      doc: {
        frontmatter: { name: "Team Reorg", description: "merge", type: "context", occurred_on: "2024-11-05" },
        body: "The team merged into Infra on 2024-11-05.",
      },
    });
    const doc = await readMemoryDocument(ctx, rel);
    assert.equal(doc?.frontmatter.occurred_on, "2024-11-05");
    assert.ok(doc?.frontmatter.created_at);
    assert.ok(doc?.frontmatter.updated_at);
  } finally {
    await cleanup(root);
  }
});

test("writeMemoryDocument rejects invalid filename", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await assert.rejects(
      writeMemoryDocument(ctx, {
        type: "identity",
        filename: "../escape.md",
        doc: { frontmatter: { name: "n", description: "", type: "identity" }, body: "b" },
      }),
      (e: unknown) => e instanceof InvalidMemoryError,
    );
  } finally {
    await cleanup(root);
  }
});

test("writeMemoryDocument refuses secrets only when refuseSecrets is set", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const fakeApiKey = "api" + "_key: supersecret12345";
    // Gate ON → refused.
    await assert.rejects(
      writeMemoryDocument(ctx, {
        type: "context",
        filename: "leak.md",
        refuseSecrets: true,
        doc: {
          frontmatter: { name: "n", description: "", type: "context" },
          body: fakeApiKey,
        },
      }),
      (e: unknown) => e instanceof SecretRefusedError,
    );

    // Gate OFF (default) → written.
    const rel = await writeMemoryDocument(ctx, {
      type: "context",
      filename: "leak2.md",
      doc: {
        frontmatter: { name: "n", description: "", type: "context" },
        body: fakeApiKey,
      },
    });
    assert.equal(rel, "context/leak2.md");
  } finally {
    await cleanup(root);
  }
});

test("writeMemoryDocument redacts <private> spans", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const rel = await writeMemoryDocument(ctx, {
      type: "context",
      filename: "p.md",
      doc: {
        frontmatter: { name: "n", description: "", type: "context" },
        body: "keep <private>hide me</private> visible",
      },
    });
    const onDisk = await readFile(path.join(root, rel), "utf8");
    assert.ok(onDisk.includes("[REDACTED]"));
    assert.ok(!onDisk.includes("hide me"));
  } finally {
    await cleanup(root);
  }
});

test("deleteMemoryDocument and archiveMemoryDocument", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const rel = await writeMemoryDocument(ctx, {
      type: "preference",
      filename: "tool.md",
      doc: { frontmatter: { name: "工具", description: "", type: "preference" }, body: "喜欢 Go" },
    });
    const archived = await archiveMemoryDocument(ctx, rel);
    assert.equal(archived, ".archive/preference/tool.md");
    assert.equal(await readMemoryDocument(ctx, rel), null);
    assert.equal(await deleteMemoryDocument(ctx, rel), false);
  } finally {
    await cleanup(root);
  }
});
