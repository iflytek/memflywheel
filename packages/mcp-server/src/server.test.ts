import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { serializeDocument, type MemoryType } from "@memscribe/core";

import {
  MemScribeMcpServer,
  INDEX_RESOURCE_URI,
  MANIFEST_RESOURCE_URI,
  WITH_MEMORY_PROMPT,
} from "./server.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memscribe-mcp-"));
}

async function writeFixture(
  root: string,
  type: MemoryType,
  filename: string,
  opts: { name: string; description?: string; body: string },
): Promise<void> {
  const dir = path.join(root, type);
  await mkdir(dir, { recursive: true });
  const serialized = serializeDocument({
    frontmatter: { name: opts.name, description: opts.description ?? "", type },
    body: opts.body,
  });
  await writeFile(path.join(dir, filename), serialized, "utf8");
}

function firstText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

test("initialize advertises tools/resources/prompts capabilities", () => {
  const server = new MemScribeMcpServer({ root: "/tmp/x-unused" });
  const info = server.handleInitialize() as Record<string, any>;
  assert.equal(info.serverInfo.name, "memscribe");
  assert.ok(info.capabilities.tools);
  assert.ok(info.capabilities.resources);
  assert.ok(info.capabilities.prompts);
  assert.equal(server.isInitialized, true);
});

test("tools/list exposes exactly memory_context, memory_read, memory_save (no search)", () => {
  const server = new MemScribeMcpServer({ root: "/tmp/x-unused" });
  const list = server.listTools() as { tools: Array<{ name: string }> };
  const names = list.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_context", "memory_read", "memory_save"]);
  assert.ok(!names.some((n) => n.includes("search")));
});

test("memory_context returns rules + full index prelude", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "identity", "u.md", { name: "用户称呼", description: "称呼", body: "叫小钟" });
    const server = new MemScribeMcpServer({ root });
    const out = await server.callTool({ name: "memory_context", arguments: {} });
    const text = firstText(out);
    assert.ok(text.includes("# 记忆"));
    assert.ok(text.includes("<system-reminder>"));
    assert.ok(text.includes("用户称呼"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_read returns body for an existing file and errors for a missing one", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "context", "proj.md", { name: "项目", body: "项目正文内容" });
    const server = new MemScribeMcpServer({ root });

    const ok = await server.callTool({
      name: "memory_read",
      arguments: { relativePath: "context/proj.md" },
    });
    assert.equal(firstText(ok), "项目正文内容");
    assert.notEqual(ok.isError, true);

    const miss = await server.callTool({
      name: "memory_read",
      arguments: { relativePath: "context/nope.md" },
    });
    assert.equal(miss.isError, true);
    assert.ok(firstText(miss).includes("No memory found"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_save writes a doc (path derived from name) and re-syncs the index", async () => {
  const root = await makeRoot();
  try {
    const server = new MemScribeMcpServer({ root });
    const out = await server.callTool({
      name: "memory_save",
      arguments: {
        type: "preference",
        name: "语气偏好",
        description: "简洁",
        body: "回答要简洁直接",
      },
    });
    // The file path is derived deterministically from the name (no filename arg).
    assert.ok(firstText(out).includes("preference/语气偏好.md"));

    const onDisk = await readFile(path.join(root, "preference", "语气偏好.md"), "utf8");
    assert.ok(onDisk.includes("回答要简洁直接"));
    assert.ok(onDisk.includes("name: 语气偏好"));

    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.ok(index.includes("preference/语气偏好.md") || index.includes("语气偏好"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_save rejects an invalid type via InvalidParams", async () => {
  const root = await makeRoot();
  try {
    const server = new MemScribeMcpServer({ root });
    const resp = await server.dispatch({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "memory_save", arguments: { type: "bogus", name: "n", body: "b" } },
    });
    assert.ok(resp && "error" in resp);
    assert.equal((resp as any).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_save redacts <private> spans and refuses secrets", async () => {
  const root = await makeRoot();
  try {
    const server = new MemScribeMcpServer({ root });
    const fakeGithubToken = "ghp" + "_0123456789abcdef0123456789abcdef0123";

    await server.callTool({
      name: "memory_save",
      arguments: { type: "context", name: "x", body: "公开 <private>隐私</private> 内容" },
    });
    const onDisk = await readFile(path.join(root, "context", "x.md"), "utf8");
    assert.ok(onDisk.includes("[REDACTED]"));
    assert.ok(!onDisk.includes("隐私"));

    const resp = await server.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: { type: "context", name: "y", body: `token=${fakeGithubToken}` },
      },
    });
    assert.ok(resp && "error" in resp);
    assert.equal((resp as any).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/list exposes index and manifest", () => {
  const server = new MemScribeMcpServer({ root: "/tmp/x-unused" });
  const list = server.listResources() as { resources: Array<{ uri: string }> };
  const uris = list.resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, [MANIFEST_RESOURCE_URI, INDEX_RESOURCE_URI].sort());
});

test("resources/read returns index and manifest content", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "workflow", "w.md", { name: "流程", description: "构建流程", body: "先 build 再 test" });
    const server = new MemScribeMcpServer({ root });

    const idx = (await server.readResource({ uri: INDEX_RESOURCE_URI })) as any;
    assert.equal(idx.contents[0].mimeType, "text/markdown");
    assert.ok(idx.contents[0].text.includes("流程") || idx.contents[0].text.includes("workflow/w.md"));

    const man = (await server.readResource({ uri: MANIFEST_RESOURCE_URI })) as any;
    assert.equal(man.contents[0].mimeType, "text/plain");
    assert.ok(man.contents[0].text.includes("workflow/w.md"));
    assert.ok(man.contents[0].text.includes("构建流程"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/read on unknown uri errors", async () => {
  const server = new MemScribeMcpServer({ root: await makeRoot() });
  const resp = await server.dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "memscribe://nope" },
  });
  assert.ok(resp && "error" in resp);
  assert.equal((resp as any).error.code, -32602);
});

test("prompts/get memscribe.with_memory returns rules + index message", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "style", "s.md", { name: "风格", description: "双引号", body: "用双引号" });
    const server = new MemScribeMcpServer({ root });
    const out = (await server.getPrompt({ name: WITH_MEMORY_PROMPT })) as any;
    const text = out.messages[0].content.text as string;
    assert.ok(text.includes("# 记忆"));
    assert.ok(text.includes("<system-reminder>"));
    assert.ok(text.includes("风格") || text.includes("style/s.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompts/list exposes only memscribe.with_memory", () => {
  const server = new MemScribeMcpServer({ root: "/tmp/x-unused" });
  const list = server.listPrompts() as { prompts: Array<{ name: string }> };
  assert.deepEqual(list.prompts.map((p) => p.name), [WITH_MEMORY_PROMPT]);
});

test("unknown method yields MethodNotFound; notifications yield no response", async () => {
  const server = new MemScribeMcpServer({ root: "/tmp/x-unused" });
  const resp = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "does/not/exist" });
  assert.ok(resp && "error" in resp);
  assert.equal((resp as any).error.code, -32601);

  const notif = await server.dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif, null);
});

test("ping replies with empty result", async () => {
  const server = new MemScribeMcpServer({ root: "/tmp/x-unused" });
  const resp = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(resp, { jsonrpc: "2.0", id: 1, result: {} });
});
