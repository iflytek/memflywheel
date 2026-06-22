import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { runStdioServer } from "./transport.js";

function collect(output: PassThrough): { lines: () => any[] } {
  let buf = "";
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
  });
  return {
    lines: () =>
      buf
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l)),
  };
}

test("stdio transport handles initialize + tools/list + prompt over streams", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memscribe-mcp-tp-"));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const collected = collect(output);

    const done = runStdioServer({ root, input, output });

    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    input.write('{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"memscribe.with_memory"}}\n');
    input.end();

    await done;

    const responses = collected.lines();
    // 3 responses (the notification produces none).
    assert.equal(responses.length, 3);

    const init = responses.find((r) => r.id === 1);
    assert.equal(init.result.serverInfo.name, "memscribe");

    const tools = responses.find((r) => r.id === 2);
    const names = tools.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ["bash", "edit", "glob", "grep", "read", "write"]);

    const ctx = responses.find((r) => r.id === 3);
    assert.ok(ctx.result.messages[0].content.text.includes("# 记忆"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio transport emits ParseError for malformed input line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memscribe-mcp-tp-"));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const collected = collect(output);

    const done = runStdioServer({ root, input, output });
    input.write("this is not json\n");
    input.end();
    await done;

    const responses = collected.lines();
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.code, -32700);
    assert.equal(responses[0].id, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
