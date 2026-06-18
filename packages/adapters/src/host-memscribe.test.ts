import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createHostMemScribe, type ToolCompletion } from "./host-memscribe.js";
import type { ToolCompletionResponse } from "@memscribe/sdk";
import { piAdapter } from "./pi.js";
import { createFakeHost, tempDir } from "./test-helpers.js";

const flush = () => new Promise((r) => setImmediate(r));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP: ToolCompletionResponse = {
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
};

/**
 * A scripted tool-calling subagent: on its first round it saves one preference
 * memory via the memory_save tool; on every subsequent round it stops. This is
 * deterministic and offline — no network, no key.
 */
function savingToolCompletion(): ToolCompletion {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "memory_save",
                arguments: JSON.stringify({
                  type: "preference",
                  name: "Preferred drink",
                  description: "User's go-to beverage",
                  body: "The user prefers green tea over coffee.",
                }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      };
    }
    return STOP;
  };
}

/** A subagent that declines: it calls no tools and replies with one sentence. */
const decliningToolCompletion: ToolCompletion = async () => STOP;

test("createHostMemScribe with a toolCompletion extracts and writes a memory end-to-end", async () => {
  const root = await tempDir();
  const { scribe } = createHostMemScribe({ toolCompletion: savingToolCompletion(), root });

  await scribe.onSessionStart({ sessionId: "s1" });
  // Await the turn-end so the full lock→agent-loop→write chain completes.
  await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [
      { role: "user", text: "I always drink green tea, never coffee." },
      { role: "assistant", text: "Got it." },
    ],
  });

  const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
  assert.match(index, /Preferred drink|preferred-drink/);
  const file = await readFile(path.join(root, "preference", "preferred-drink.md"), "utf8");
  assert.match(file, /green tea/);
});

test("attach drives a real end-to-end extraction through host events", async () => {
  const root = await tempDir();
  const { scribe } = createHostMemScribe({ toolCompletion: savingToolCompletion(), root });
  const host = createFakeHost();
  const dispose = piAdapter.attach(scribe, host);

  host.emit("session:ensure", { sessionId: "s1" });
  host.emit("agent_end", {
    sessionId: "s1",
    messages: [
      { role: "user", text: "I always drink green tea, never coffee." },
      { role: "assistant", text: "Got it." },
    ],
  });

  // Fire-and-forget: poll until the subagent's write lands (or time out).
  // The lock→agent-loop→write chain is real async I/O, so yield real time (not
  // just a microtask flush) on each iteration to stay robust under load.
  let body = "";
  for (let i = 0; i < 200 && !body; i++) {
    await flush();
    await tick(5);
    body = await readFile(path.join(root, "preference", "preferred-drink.md"), "utf8").catch(
      () => "",
    );
  }
  assert.match(body, /green tea/);
  dispose();
});

test("createHostMemScribe prompt build returns the two recall segments", async () => {
  const root = await tempDir();
  const { scribe } = createHostMemScribe({ toolCompletion: savingToolCompletion(), root });

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.equal(ctx.enabled, true);
  assert.ok(typeof ctx.systemPrompt === "string");
  assert.ok(typeof ctx.preludePrompt === "string");
});

test("createHostMemScribe without a toolCompletion is recall-only (no extraction)", async () => {
  const root = await tempDir();
  const { scribe } = createHostMemScribe({ root });

  await scribe.onSessionStart({ sessionId: "s1" });
  await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [{ role: "user", text: "I always drink green tea." }],
  });

  // No preference file should have been written.
  await assert.rejects(
    readFile(path.join(root, "preference", "preferred-drink.md"), "utf8"),
    /ENOENT/,
  );
  // Recall still works.
  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.equal(ctx.enabled, true);
});

test("createHostMemScribe decline (no tool calls) writes nothing", async () => {
  const root = await tempDir();
  const { scribe } = createHostMemScribe({ toolCompletion: decliningToolCompletion, root });

  await scribe.onSessionStart({ sessionId: "s1" });
  await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [{ role: "user", text: "what time is it?" }],
  });

  await assert.rejects(
    readFile(path.join(root, "preference", "preferred-drink.md"), "utf8"),
    /ENOENT/,
  );
});

test("disabled scribe makes every hook a no-op", async () => {
  const root = await tempDir();
  const { scribe } = createHostMemScribe({ toolCompletion: savingToolCompletion(), root, enabled: false });

  await scribe.onSessionStart({ sessionId: "s1" });
  await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [{ role: "user", text: "I always drink green tea." }],
  });

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.equal(ctx.enabled, false);
  await assert.rejects(readFile(path.join(root, "MEMORY.md"), "utf8"), /ENOENT/);
});
