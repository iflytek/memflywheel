import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createFileTools,
  createMemoryFileToolContext,
  fileToolMap,
  serializeMemoryFile,
} from "./file-tools.js";
import { createNullAuditLogger } from "./audit.js";
import { readMemoryIndex } from "./index-file.js";
import { readMemoryDocument, type StorageContext } from "./storage.js";
import { makeRoot, cleanup } from "./test-helpers.js";

function tools(root: string, refuseSecrets = false) {
  const ctx: StorageContext = { root, audit: createNullAuditLogger() };
  const toolCtx = createMemoryFileToolContext({ ctx, refuseSecrets });
  const map = fileToolMap(createFileTools());
  return { ctx, toolCtx, map };
}

test("file tool schemas expose ordinary OpenCode-style tool names", () => {
  for (const tool of createFileTools()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
  assert.deepEqual(createFileTools().map((tool) => tool.name).sort(), [
    "bash",
    "edit",
    "glob",
    "grep",
    "read",
    "write",
  ]);
});

test("write validates memory frontmatter, writes atomically, and resyncs the index", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    const write = map.get("write")!;
    const result = await write.handler(
      {
        filePath: "preference/drinks.md",
        content: serializeMemoryFile({
          type: "preference",
          name: "Drinks",
          description: "Beverages",
          body: "Prefers green tea.",
        }),
      },
      toolCtx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, ["preference/drinks.md"]);
    assert.equal((await readMemoryDocument(ctx, "preference/drinks.md"))?.body, "Prefers green tea.");
    assert.match(await readMemoryIndex(root), /preference\/drinks\.md/);
  } finally {
    await cleanup(root);
  }
});

test("read returns numbered file content and edit preserves existing memory facts", async () => {
  const root = await makeRoot();
  try {
    const { ctx, toolCtx, map } = tools(root);
    await map.get("write")!.handler(
      {
        filePath: "preference/drinks.md",
        content: serializeMemoryFile({
          type: "preference",
          name: "Drinks",
          body: "Likes green tea.",
        }),
      },
      toolCtx,
    );

    const read = await map.get("read")!.handler({ filePath: "preference/drinks.md" }, toolCtx);
    assert.equal(read.ok, true);
    assert.match(read.text, /Likes green tea/);

    const edit = await map.get("edit")!.handler(
      {
        filePath: "preference/drinks.md",
        oldString: "Likes green tea.",
        newString: "Likes green tea. Also likes black coffee.",
      },
      toolCtx,
    );
    assert.equal(edit.ok, true);
    const doc = await readMemoryDocument(ctx, "preference/drinks.md");
    assert.match(doc?.body ?? "", /green tea/);
    assert.match(doc?.body ?? "", /black coffee/);
  } finally {
    await cleanup(root);
  }
});

test("write rejects invalid memory type/path and secret gate refuses obvious secrets", async () => {
  const root = await makeRoot();
  try {
    const off = tools(root, false);
    const wrongPath = await off.map.get("write")!.handler(
      {
        filePath: "preference/bad.md",
        content: serializeMemoryFile({ type: "workflow", name: "Bad", body: "Wrong type." }),
      },
      off.toolCtx,
    );
    assert.equal(wrongPath.ok, false);

    const on = tools(root, true);
    const refused = await on.map.get("write")!.handler(
      {
        filePath: "context/leak.md",
        content: serializeMemoryFile({
          type: "context",
          name: "Leak",
          body: "password: hunter2xx",
        }),
      },
      on.toolCtx,
    );
    assert.equal(refused.ok, false);
    assert.equal(await readMemoryDocument(on.ctx, "context/leak.md"), null);
  } finally {
    await cleanup(root);
  }
});

test("glob, grep, and bash expose ordinary file operations", async () => {
  const root = await makeRoot();
  try {
    const { toolCtx, map } = tools(root);
    await map.get("write")!.handler(
      {
        filePath: "context/project.md",
        content: serializeMemoryFile({
          type: "context",
          name: "Project",
          body: "The project uses pnpm.",
        }),
      },
      toolCtx,
    );

    const glob = await map.get("glob")!.handler({ pattern: "**/*.md" }, toolCtx);
    assert.match(glob.text, /context\/project\.md/);
    const grep = await map.get("grep")!.handler({ pattern: "pnpm", include: "**/*.md" }, toolCtx);
    assert.match(grep.text, /Line/);
    const bash = await map.get("bash")!.handler({ command: "pwd", description: "show root" }, toolCtx);
    assert.equal(bash.ok, true);
    assert.match(bash.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await cleanup(root);
  }
});
