import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  selectMessagesForExtraction,
  cleanMessages,
  stripSystemReminderBlocks,
  runExtractionSession,
  createMemoryCursorStore,
  relocateRootFiles,
  ExtractionResult,
  type ExtractionMessage,
  type ExtractionAgentRunner,
  EXTRACTION_MAX_MESSAGES,
} from "./extract.js";
import { fileToolMap, serializeMemoryFile } from "./file-tools.js";
import { type StorageContext, readMemoryDocument } from "./storage.js";
import { scanMemoryFiles } from "./scan.js";
import { createNullAuditLogger } from "./audit.js";
import { makeRoot, cleanup, writeRaw } from "./test-helpers.js";

function ctxFor(root: string): StorageContext {
  return { root, audit: createNullAuditLogger() };
}

function msgs(n: number): ExtractionMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `m${i}`,
  }));
}

test("selectMessagesForExtraction first run takes last MAX messages", () => {
  const selected = selectMessagesForExtraction(msgs(60), null);
  assert.equal(selected.length, EXTRACTION_MAX_MESSAGES);
});

test("selectMessagesForExtraction returns new + context window after cursor", () => {
  const all = msgs(20);
  const selected = selectMessagesForExtraction(all, 15);
  assert.equal(selected.length, 4 + 6);
  assert.equal(selected.at(-1)!.text, "m19");
});

test("selectMessagesForExtraction returns [] when no new messages", () => {
  const all = msgs(10);
  assert.deepEqual(selectMessagesForExtraction(all, 9), []);
});

test("cleanMessages strips system-reminder + prelude from user turns", () => {
  assert.equal(stripSystemReminderBlocks("<system-reminder>x</system-reminder>hi"), "hi");
  const cleaned = cleanMessages([
    { role: "user", text: "<system-reminder>idx</system-reminder>\nreal question" },
    { role: "user", text: "<system>boot</system>" },
    { role: "assistant", text: "<system-reminder>keep</system-reminder>" },
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0]!.text, "real question");
  assert.equal(cleaned[1]!.role, "assistant");
});

test("cleanMessages preserves the per-turn timestamp anchor", () => {
  const cleaned = cleanMessages([
    { role: "user", text: "I went to the support group yesterday", timestamp: "2023-05-08" },
    { role: "assistant", text: "Got it", timestamp: "2023-05-08" },
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0]!.timestamp, "2023-05-08");
  assert.equal(cleaned[1]!.timestamp, "2023-05-08");
});

test("relocateRootFiles moves stray root .md into typed dir", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    await writeRaw(root, "stray.md", "---\nname: 漂移\ntype: workflow\n---\n\n正文");
    const moved = await relocateRootFiles(ctx);
    assert.deepEqual(moved, ["workflow/stray.md"]);
    const entries = await scanMemoryFiles(root);
    assert.equal(entries.find((e) => e.relativePath === "workflow/stray.md")?.name, "漂移");
  } finally {
    await cleanup(root);
  }
});

/** A fake agent runner that writes one memory via the supplied file tools. */
function fakeSaveAgent(save: { type: string; name: string; body: string }): ExtractionAgentRunner {
  return async ({ toolCtx, tools }) => {
    const map = fileToolMap(tools);
    const res = await map.get("write")!.handler(
      {
        filePath: `${save.type}/${save.name}.md`,
        content: serializeMemoryFile({
          type: save.type as never,
          name: save.name,
          body: save.body,
        }),
      },
      toolCtx,
    );
    return { changed: res.changed ?? [] };
  };
}

test("runExtractionSession drives the agent runner, syncs index, advances cursor", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const cursorStore = createMemoryCursorStore();
    let seenManifest = "";
    const agent: ExtractionAgentRunner = async (input) => {
      seenManifest = input.manifest;
      const map = fileToolMap(input.tools);
      const res = await map.get("write")!.handler(
        {
          filePath: "preference/工具.md",
          content: serializeMemoryFile({
            type: "preference",
            name: "工具",
            body: "喜欢 Go",
          }),
        },
        input.toolCtx,
      );
      return { changed: res.changed ?? [] };
    };

    const result = await runExtractionSession({
      ctx,
      agent,
      messages: [
        { role: "user", text: "我喜欢 Go" },
        { role: "assistant", text: "好的" },
      ],
      sessionId: "s1",
      cursorStore,
    });

    assert.equal(result, ExtractionResult.Completed);
    assert.ok(await readMemoryDocument(ctx, "preference/工具.md"));
    assert.equal(seenManifest, "（无现有记忆）");
    assert.equal(cursorStore.get("s1"), 1);

    // Second run with no new messages → skipped.
    const again = await runExtractionSession({
      ctx,
      agent,
      messages: [
        { role: "user", text: "我喜欢 Go" },
        { role: "assistant", text: "好的" },
      ],
      sessionId: "s1",
      cursorStore,
    });
    assert.equal(again, ExtractionResult.Skipped);
  } finally {
    await cleanup(root);
  }
});

test("runExtractionSession appends source refs to multiple memories from the same selected trace", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const agent: ExtractionAgentRunner = async (input) => {
      const map = fileToolMap(input.tools);
      await map.get("write")!.handler(
        {
          filePath: "workflow/release.md",
          content: serializeMemoryFile({
            type: "workflow",
            name: "Release flow",
            body: "Run build before publishing.",
          }),
        },
        input.toolCtx,
      );
      await map.get("write")!.handler(
        {
          filePath: "preference/tone.md",
          content: serializeMemoryFile({
            type: "preference",
            name: "Tone",
            body: "Prefers direct answers.",
          }),
        },
        input.toolCtx,
      );
      return { changed: ["workflow/release.md", "preference/tone.md"] };
    };

    const result = await runExtractionSession({
      ctx,
      agent,
      messages: [
        { role: "user", text: "发布前先跑 build", timestamp: "2026-06-23" },
        {
          role: "assistant",
          text: "好的",
          toolCalls: [{ name: "Bash", input: { command: "pnpm build" }, output: "done" }],
        },
      ],
      sessionId: "session-with-two-memories",
      cursorStore: createMemoryCursorStore(),
    });

    assert.equal(result, ExtractionResult.Completed);
    const release = await readFile(path.join(root, "workflow", "release.md"), "utf8");
    const tone = await readFile(path.join(root, "preference", "tone.md"), "utf8");
    const sourceRef = release.match(/- (?<ref>\.memscribe\/sources\/[^#]+\.jsonl#L\d+-L\d+)/)?.groups?.ref;
    assert.ok(sourceRef);
    assert.ok(tone.includes(sourceRef));

    const sourcePath = sourceRef.split("#")[0]!;
    const source = await readFile(path.join(root, sourcePath), "utf8");
    const lines = source.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /发布前先跑 build/);
    assert.match(lines[1]!, /"toolCalls"/);
    assert.match(lines[1]!, /pnpm build/);

    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.doesNotMatch(index, /\.memscribe\/sources/);
  } finally {
    await cleanup(root);
  }
});

test("runExtractionSession writes only new messages to source traces, not cursor context", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const cursorStore = createMemoryCursorStore();
    let calls = 0;
    const agent: ExtractionAgentRunner = async (input) => {
      calls += 1;
      const map = fileToolMap(input.tools);
      const name = calls === 1 ? "First fact" : "Second fact";
      const filePath = calls === 1 ? "workflow/first.md" : "workflow/second.md";
      await map.get("write")!.handler(
        {
          filePath,
          content: serializeMemoryFile({
            type: "workflow",
            name,
            body: `${name} body.`,
          }),
        },
        input.toolCtx,
      );
      if (calls === 2) {
        assert.equal(input.messages.length, 4, "the extraction agent still sees cursor context");
      }
      return { changed: [filePath] };
    };

    const allMessages: ExtractionMessage[] = [
      { role: "user", text: "first remembered fact" },
      { role: "assistant", text: "ack one" },
      { role: "user", text: "second remembered fact" },
      { role: "assistant", text: "ack two" },
    ];

    assert.equal(
      await runExtractionSession({
        ctx,
        agent,
        messages: allMessages.slice(0, 2),
        sessionId: "repeat-source-session",
        cursorStore,
      }),
      ExtractionResult.Completed,
    );
    assert.equal(
      await runExtractionSession({
        ctx,
        agent,
        messages: allMessages,
        sessionId: "repeat-source-session",
        cursorStore,
      }),
      ExtractionResult.Completed,
    );

    const second = await readFile(path.join(root, "workflow", "second.md"), "utf8");
    assert.match(second, /\.memscribe\/sources\/session-[a-f0-9]+\.jsonl#L3-L4/);
    const sourcePath = second.match(/- (?<path>\.memscribe\/sources\/[^#]+\.jsonl)#L3-L4/)?.groups?.path;
    assert.ok(sourcePath);
    const lines = (await readFile(path.join(root, sourcePath), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines.filter((line) => line.includes("first remembered fact")).length, 1);
    assert.equal(lines.filter((line) => line.includes("second remembered fact")).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("runExtractionSession returns Skipped when the agent writes nothing", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const result = await runExtractionSession({
      ctx,
      agent: async () => ({ changed: [] }),
      messages: [{ role: "user", text: "just chatting" }],
      sessionId: "s-noop",
      cursorStore: createMemoryCursorStore(),
    });
    assert.equal(result, ExtractionResult.Skipped);
  } finally {
    await cleanup(root);
  }
});

test("runExtractionSession returns Failed and does NOT advance cursor when agent throws", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const cursorStore = createMemoryCursorStore();
    const result = await runExtractionSession({
      ctx,
      agent: async () => {
        throw new Error("llm down");
      },
      messages: [{ role: "user", text: "hi" }],
      sessionId: "s2",
      cursorStore,
    });
    assert.equal(result, ExtractionResult.Failed);
    assert.equal(cursorStore.get("s2"), null);
  } finally {
    await cleanup(root);
  }
});

test("runExtractionSession threads refuseSecrets into the tools", async () => {
  const root = await makeRoot();
  try {
    const ctx = ctxFor(root);
    const fakePassword = "pass" + "word: hunter2xx";
    // With the gate ON, the save handler refuses → nothing written → Skipped.
    const result = await runExtractionSession({
      ctx,
      agent: fakeSaveAgent({ type: "context", name: "Leak", body: fakePassword }),
      messages: [{ role: "user", text: "secret" }],
      sessionId: "s-gate",
      cursorStore: createMemoryCursorStore(),
      refuseSecrets: true,
    });
    assert.equal(result, ExtractionResult.Skipped);
    assert.equal(await readMemoryDocument(ctx, "context/leak.md"), null);
  } finally {
    await cleanup(root);
  }
});
