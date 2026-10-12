import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";

test(
  "Hermes worker preserves host instructions and tools across model RPC",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "memflywheel-hermes-rpc-"));
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bridge/worker.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          MEMFLYWHEEL_PACKAGE_IMPORT: new URL("./index.js", import.meta.url).href,
        },
        stdio: "pipe",
      },
    );
    const closed = once(worker, "close");
    const lines = createInterface({ input: worker.stdout });
    const responses = lines[Symbol.asyncIterator]();
    let stderr = "";
    worker.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      lines.close();
      worker.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    });
    const send = (message: object) => worker.stdin.write(`${JSON.stringify(message)}\n`);
    let modelCalls = 0;
    async function command(name: string, payload: object) {
      send({ type: "command", id: name, command: name, payload });
      for (;;) {
        const line = await responses.next();
        assert.equal(line.done, false, stderr);
        const message = JSON.parse(line.value);
        if (message.type === "command_response") {
          assert.equal(message.id, name);
          assert.equal(message.error, undefined);
          return;
        }
        assert.equal(message.type, "model_request");
        const context = message.request.context;
        assert.match(context.systemPrompt, /memory extraction engine/);
        assert.ok(context.tools.some((tool: { name: string }) => tool.name === "write"));
        assert.ok(context.messages.every((entry: { role: string }) => entry.role !== "system"));
        modelCalls += 1;
        const content: AssistantMessage["content"] = [];
        if (modelCalls === 1) {
          const args: JsonObject = {
            filePath: "preference/tea.md",
            content:
              "---\ntype: preference\nname: Tea\ndescription: Preferred drink\n---\nThe user prefers tea.\n",
          };
          content.push({ type: "toolCall", id: "write-tea", name: "write", arguments: args });
        } else {
          assert.ok(
            context.messages.some((entry: { role: string }) => entry.role === "toolResult"),
          );
          content.push({ type: "text", text: "done" });
        }
        const result: AssistantMessage = {
          role: "assistant",
          content,
          api: "openai-completions",
          provider: "hermes",
          model: "host-active",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: modelCalls === 1 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        send({ type: "model_response", id: message.id, result });
      }
    }
    const payload = { sessionId: "hermes-rpc", root, learnedSkills: false };
    await command("initialize", payload);
    await command("turn_end", {
      ...payload,
      messages: [
        { role: "user", text: "Remember that I prefer tea." },
        { role: "assistant", text: "I will remember." },
      ],
    });
    assert.equal(modelCalls, 2);
    assert.match(await readFile(join(root, "preference", "tea.md"), "utf8"), /prefers tea/);
  },
);
