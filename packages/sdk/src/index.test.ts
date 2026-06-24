import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMemScribe,
  ExtractionResult,
  type ExtractionAgentRunner,
  type DreamAgentRunner,
  type EmbeddingProvider,
} from "./index.js";
import { readDreamState, markDreamConsolidated, serializeMemoryFile, type MemoryType } from "@memscribe/core";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memscribe-sdk-"));
}

function userTurn(text: string) {
  return [{ role: "user" as const, text }];
}

/**
 * A fake ExtractionAgentRunner that, on its first call, writes one memory via the
 * supplied ordinary file tools (exactly as the real tool-calling loop would), then does
 * nothing on subsequent calls. Returns the changed paths the tool reported.
 */
function memorySlug(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-+|-+$/g, "") || "memory"}.md`;
}

function writeMemoryArgs(input: {
  type: MemoryType;
  name: string;
  description?: string;
  body: string;
  filename?: string;
}) {
  return {
    filePath: `${input.type}/${input.filename ?? memorySlug(input.name)}`,
    content: serializeMemoryFile(input),
  };
}

function onceAgent(save: { type: MemoryType; name: string; description?: string; body: string }): {
  fn: ExtractionAgentRunner;
  calls: () => number;
} {
  let calls = 0;
  const fn: ExtractionAgentRunner = async ({ tools, toolCtx }) => {
    calls += 1;
    if (calls !== 1) return { changed: [] };
    const writeTool = tools.find((t) => t.name === "write");
    assert.ok(writeTool, "write tool is supplied to the agent");
    const result = await writeTool.handler(writeMemoryArgs(save), toolCtx);
    return { changed: result.changed ?? [] };
  };
  return { fn, calls: () => calls };
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

test("onPromptBuild returns stable rules + system-reminder-wrapped index, empty when no memory", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    await scribe.onSessionStart("s1");
    const ctx = await scribe.onPromptBuild({ sessionId: "s1" });

    assert.equal(ctx.enabled, true);
    assert.ok(ctx.systemPrompt.includes("记忆"), "stable rules present");
    assert.match(ctx.preludePrompt, /<system-reminder>[\s\S]*<\/system-reminder>/);
    assert.match(ctx.preludePrompt, /没有可用记忆条目/);
    assert.equal(scribe.instructionPrompt(), ctx.systemPrompt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onPromptBuild injects learned skill routing", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({
      root,
      skillRecall: async () => {
        return {
          entries: [
            {
              name: "memscribe-learned-release-review",
              displayName: "Release Review",
              description: "Review release readiness with a repeatable checklist.",
              relativePath: "memscribe-learned-release-review/SKILL.md",
              triggerHints: ["release prep", "pre-publish review"],
            },
          ],
        };
      },
    });

    const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
    assert.match(ctx.systemPrompt, /# 技能/);
    assert.match(ctx.preludePrompt, /## 可用技能/);
    assert.match(ctx.preludePrompt, /memscribe-learned-release-review/);
    assert.match(ctx.preludePrompt, /pre-publish review/);
    assert.match(ctx.skillPreludePrompt ?? "", /Release Review/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onPromptBuild passes query into memory index retrieval", async () => {
  const root = await tempRoot();
  try {
    await mkdir(path.join(root, "workflow"), { recursive: true });
    await mkdir(path.join(root, "preference"), { recursive: true });
    await writeFile(
      path.join(root, "workflow", "release.md"),
      serializeMemoryFile({
        type: "workflow",
        name: "发布流程",
        description: "pnpm build 后打 tag",
        body: "release",
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "preference", "tea.md"),
      serializeMemoryFile({
        type: "preference",
        name: "饮茶偏好",
        description: "喜欢茉莉花茶",
        body: "tea",
      }),
      "utf8",
    );

    const scribe = createMemScribe({
      root,
      memoryIndexRetrieval: {
        embeddingProvider: releaseEmbeddingProvider(),
        minRecords: 1,
        limit: 1,
      },
    });

    const ctx = await scribe.onPromptBuild({ sessionId: "s1", query: "如何发布这个包" });
    assert.match(ctx.preludePrompt, /## 相关记忆条目/);
    assert.match(ctx.preludePrompt, /发布流程/);
    assert.doesNotMatch(ctx.preludePrompt, /饮茶偏好/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled scribe produces no recall, no writes", async () => {
  const root = await tempRoot();
  try {
    const { fn } = onceAgent({ type: "preference", name: "fruit", body: "likes strawberries" });
    const scribe = createMemScribe({ root, enabled: false, agent: fn });
    assert.equal(scribe.enabled, false);

    const ctx = await scribe.onPromptBuild();
    assert.equal(ctx.enabled, false);
    assert.equal(ctx.systemPrompt, "");
    assert.equal(ctx.preludePrompt, "");

    const turn = await scribe.onTurnEnd("s1", userTurn("I love strawberries"));
    assert.equal(turn.skipped, true);
    assert.equal(turn.result, ExtractionResult.Skipped);

    const saved = await scribe.save({ type: "preference", name: "fruit", body: "likes strawberries" });
    assert.equal(saved, ExtractionResult.Skipped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onTurnEnd with no agent configured is a no-op skip", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    await scribe.onSessionStart("s1");
    const turn = await scribe.onTurnEnd("s1", userTurn("hello"));
    assert.equal(turn.skipped, true);
    assert.equal(turn.result, ExtractionResult.Skipped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("after-turn extraction: the agent writes a memory, it is indexed; cursor advances", async () => {
  const root = await tempRoot();
  try {
    const { fn, calls } = onceAgent({
      type: "preference",
      name: "favorite fruit",
      description: "likes strawberries",
      body: "User likes strawberries.",
    });
    const scribe = createMemScribe({ root, agent: fn });
    await scribe.onSessionStart("s1");

    const turn = await scribe.onTurnEnd("s1", [
      { role: "user", text: "记住：我喜欢草莓" },
      { role: "assistant", text: "好的" },
    ]);
    assert.equal(turn.skipped, false);
    assert.equal(turn.result, ExtractionResult.Completed);
    assert.equal(calls(), 1);

    const filePath = path.join(root, "preference", "favorite-fruit.md");
    const raw = await readFile(filePath, "utf8");
    assert.match(raw, /type: preference/);
    assert.match(raw, /name: favorite fruit/);
    assert.match(raw, /User likes strawberries\./);

    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.match(index, /favorite fruit/);

    const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
    assert.match(ctx.preludePrompt, /favorite fruit/);

    // Cursor advanced: a second turn-end with no new content re-runs the agent
    // only over the new window; the agent returns no changes ⇒ Skipped.
    const turn2 = await scribe.onTurnEnd("s1", []);
    assert.equal(turn2.result, ExtractionResult.Skipped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onTurnEnd runs the integrated learning loop and routes skill memory compression to dream", async () => {
  const root = await tempRoot();
  try {
    const events: string[] = [];
    const { fn } = onceAgent({
      type: "workflow",
      name: "release prep",
      description: "reusable release workflow",
      body: "Run package metadata checks, README checks, and dry-run pack checks.",
    });
    const dreamRunner: DreamAgentRunner = async ({ coordination }) => {
      events.push(`dream:${coordination?.memoryAction}:${coordination?.topics.join(",")}:${coordination?.targetSkill}`);
      return { changed: [] };
    };
    const scribe = createMemScribe({
      root,
      agent: fn,
      dreamRunner,
      learningLoop: {
        enabled: true,
        source: "local",
        skillLearningEnabled: true,
        gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 1 },
        skillEvolution: async ({ lastExtraction }) => {
          events.push(`skill:${lastExtraction.result}`);
          return {
            coordination: {
              decision: "update",
              targetSkill: "memscribe-learned-release-review",
              mergedSkills: [],
              why: "Release prep has become a reusable procedure.",
              memoryAction: "compress-memory",
              memoryTopics: ["release prep"],
              supportingFiles: ["memscribe-learned-release-review/SKILL.md"],
            },
            changedSkills: ["memscribe-learned-release-review"],
            changedFiles: ["memscribe-learned-release-review/SKILL.md"],
          };
        },
      },
    });

    const turn = await scribe.onTurnEnd("s1", [
      {
        role: "assistant",
        text: "release prep done",
        toolCalls: [{ name: "pnpm", input: { command: "pnpm run ci" }, output: "ok" }],
      },
    ]);

    assert.equal(turn.result, ExtractionResult.Completed);
    assert.equal(turn.learningLoop?.extraction.ran, true);
    assert.equal(turn.learningLoop?.skillEvolution.ran, true);
    assert.equal(turn.learningLoop?.dream.ran, true);
    assert.deepEqual(events, [
      "skill:completed",
      "dream:compress-memory:release prep:memscribe-learned-release-review",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onTurnEnd learning loop does not evolve skills when extraction writes nothing", async () => {
  const root = await tempRoot();
  try {
    const events: string[] = [];
    const agent: ExtractionAgentRunner = async () => ({ changed: [] });
    const scribe = createMemScribe({
      root,
      agent,
      learningLoop: {
        enabled: true,
        source: "local",
        skillLearningEnabled: true,
        gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 0 },
        skillEvolution: async () => {
          events.push("skill");
          throw new Error("must not run");
        },
      },
    });

    const turn = await scribe.onTurnEnd("s1", userTurn("nothing durable"));

    assert.equal(turn.result, ExtractionResult.Skipped);
    assert.equal(turn.learningLoop?.extraction.ran, true);
    assert.equal(turn.learningLoop?.skillEvolution.ran, false);
    assert.equal(turn.learningLoop?.skillEvolution.reason, "extraction-not-completed");
    assert.equal(turn.learningLoop?.dream.ran, false);
    assert.deepEqual(events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onTurnEnd learning loop uses captured tool calls and internal cooldown counters by default", async () => {
  const root = await tempRoot();
  try {
    const events: string[] = [];
    const { fn } = onceAgent({
      type: "workflow",
      name: "release prep",
      description: "reusable release workflow",
      body: "Run package metadata checks, README checks, and dry-run pack checks.",
    });
    const scribe = createMemScribe({
      root,
      agent: fn,
      learningLoop: {
        enabled: true,
        source: "local",
        skillLearningEnabled: true,
        gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 1 },
        skillEvolution: async () => {
          events.push("skill");
          return {
            coordination: {
              decision: "noop",
              targetSkill: null,
              mergedSkills: [],
              why: "No change needed.",
              memoryAction: "noop",
              memoryTopics: [],
              supportingFiles: [],
            },
            changedSkills: [],
            changedFiles: [],
          };
        },
      },
    });

    const turn = await scribe.onTurnEnd("s1", [
      {
        role: "assistant",
        text: "release prep done",
        toolCalls: [{ name: "pnpm", input: { command: "pnpm run ci" }, output: "ok" }],
      },
    ]);

    assert.equal(turn.result, ExtractionResult.Completed);
    assert.equal(turn.learningLoop?.skillEvolution.ran, true);
    assert.deepEqual(events, ["skill"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent that throws yields Failed and writes nothing; cursor does not advance", async () => {
  const root = await tempRoot();
  try {
    let calls = 0;
    const fn: ExtractionAgentRunner = async () => {
      calls += 1;
      throw new Error("llm down");
    };
    const scribe = createMemScribe({ root, agent: fn });
    await scribe.onSessionStart("s1");
    const turn = await scribe.onTurnEnd("s1", userTurn("anything worth remembering"));
    assert.equal(turn.result, ExtractionResult.Failed);

    const index = await readFile(path.join(root, "MEMORY.md"), "utf8").catch(() => "");
    assert.doesNotMatch(index, /\.md/);

    // Cursor did not advance: the next turn retries the same window.
    const turn2 = await scribe.onTurnEnd("s1", []);
    assert.equal(turn2.result, ExtractionResult.Failed);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent attempting a secret save is gated only when refuseSecrets is on", async () => {
  const fakeOpenAiKey = "sk" + "-ABCDEF0123456789ABCDEF0123456789";

  // Default (refuseSecrets off): privacy via prompt; a tool save still writes.
  const rootOff = await tempRoot();
  try {
    const fn: ExtractionAgentRunner = async ({ tools, toolCtx }) => {
      const write = tools.find((t) => t.name === "write")!;
      const r = await write.handler(
        writeMemoryArgs({ type: "context", name: "creds", body: `the api key is ${fakeOpenAiKey}` }),
        toolCtx,
      );
      return { changed: r.changed ?? [] };
    };
    const scribe = createMemScribe({ root: rootOff, agent: fn });
    await scribe.onSessionStart("s1");
    const turn = await scribe.onTurnEnd("s1", userTurn("here is a secret"));
    assert.equal(turn.result, ExtractionResult.Completed);
  } finally {
    await rm(rootOff, { recursive: true, force: true });
  }

  // refuseSecrets on: the handler refuses, nothing changes ⇒ Skipped.
  const rootOn = await tempRoot();
  try {
    const fn: ExtractionAgentRunner = async ({ tools, toolCtx }) => {
      const write = tools.find((t) => t.name === "write")!;
      const r = await write.handler(
        writeMemoryArgs({ type: "context", name: "creds", body: `the api key is ${fakeOpenAiKey}` }),
        toolCtx,
      );
      assert.equal(r.ok, false, "secret save refused under refuseSecrets");
      return { changed: r.changed ?? [] };
    };
    const scribe = createMemScribe({ root: rootOn, agent: fn, refuseSecrets: true });
    await scribe.onSessionStart("s1");
    const turn = await scribe.onTurnEnd("s1", userTurn("here is a secret"));
    assert.equal(turn.result, ExtractionResult.Skipped);
    const index = await readFile(path.join(rootOn, "MEMORY.md"), "utf8").catch(() => "");
    assert.doesNotMatch(index, /creds/);
  } finally {
    await rm(rootOn, { recursive: true, force: true });
  }
});

test("explicit save writes and syncs index", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    const result = await scribe.save({
      type: "identity",
      name: "user name",
      description: "preferred name",
      body: "Call the user Kaye.",
    });
    assert.equal(result, ExtractionResult.Completed);

    const raw = await readFile(path.join(root, "identity", "user-name.md"), "utf8");
    assert.match(raw, /type: identity/);
    assert.match(raw, /name: user name/);
    assert.match(raw, /Call the user Kaye\./);

    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.match(index, /user name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save with archives archives the corrected memory then writes the new one", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    await scribe.save({ type: "preference", name: "old", body: "User dislikes tea." });
    const result = await scribe.save({
      type: "preference",
      name: "new",
      body: "User actually loves tea.",
      archives: ["preference/old.md"],
    });
    assert.equal(result, ExtractionResult.Completed);

    await readFile(path.join(root, "preference", "new.md"), "utf8");
    await assert.rejects(readFile(path.join(root, "preference", "old.md"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onIdle gate: not met ⇒ no run; session-count threshold ⇒ runs", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    await scribe.onSessionStart("s1");

    const idle = await scribe.onIdle({ candidateSessionCount: 0, lastConsolidatedAt: null });
    assert.equal(idle.ran, false);
    assert.equal(idle.reason, "gate-not-met");

    const idle2 = await scribe.onIdle({ candidateSessionCount: 10 });
    assert.equal(idle2.ran, true);
    assert.equal(idle2.reason, "ok");
    assert.ok(Array.isArray(idle2.changed));
    assert.ok(Array.isArray(idle2.deleted));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic dream relocates a root-level mistyped file (no runner)", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "stray.md"),
      "---\nname: stray\ndescription: d\ntype: preference\n---\n\nstray body\n",
      "utf8",
    );

    const dream = await scribe.runDream();
    assert.equal(dream.ran, true);

    await readFile(path.join(root, "preference", "stray.md"), "utf8");
    await assert.rejects(readFile(path.join(root, "stray.md"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dreamRunner injection point is invoked and consolidates via ordinary file tools", async () => {
  const root = await tempRoot();
  try {
    let runnerSeen = false;
    // The subagent reads the full body first, then edits the same file through
    // the ordinary file tool surface.
    const runner: DreamAgentRunner = async ({ root: r, tools, toolCtx }) => {
      runnerSeen = true;
      assert.ok(typeof r === "string");
      const map = new Map(tools.map((t) => [t.name, t]));
      const read = map.get("read")!;
      const edit = map.get("edit")!;
      const before = await read.handler({ filePath: "context/term.md" }, toolCtx);
      assert.ok(before.ok);
      const res = await edit.handler(
        {
          filePath: "context/term.md",
          oldString: "the original long body of the term memory",
          newString: "shorter body",
        },
        toolCtx,
      );
      return { changed: res.ok && res.changed ? res.changed : [] };
    };
    const scribe = createMemScribe({ root, dreamRunner: runner });
    await scribe.save({
      type: "context",
      name: "term",
      description: "a term",
      body: "the original long body of the term memory",
    });

    const dream = await scribe.runDream({
      reason: "idle",
      memoryAction: "consolidate",
      topics: ["term"],
    });
    assert.equal(dream.ran, true);
    assert.equal(runnerSeen, true);
    assert.ok(dream.changed?.includes("context/term.md"));

    const raw = await readFile(path.join(root, "context", "term.md"), "utf8");
    assert.match(raw, /shorter body/);
    assert.match(raw, /name: term/);
    assert.match(raw, /description: a term/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: a fresh store with no inputs does not run", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    const idle = await scribe.onIdle(); // no gate inputs at all
    assert.equal(idle.ran, false);
    assert.equal(idle.reason, "gate-not-met");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: the scribe counts ended sessions, fires at the threshold, then resets", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    for (let i = 0; i < 5; i += 1) {
      await scribe.onSessionStart(`s${i}`);
      await scribe.onSessionEnd(`s${i}`);
    }
    // 5 ended sessions ⇒ persisted count reaches the default threshold (5).
    const idle = await scribe.onIdle(); // no inputs — uses the scribe's own bookkeeping
    assert.equal(idle.ran, true);
    assert.equal(idle.reason, "ok");

    // The pass reset the gate: counter back to 0, last consolidation stamped.
    const st = await readDreamState(root);
    assert.equal(st.sessionsSince, 0);
    assert.notEqual(st.lastConsolidatedAt, null);

    // Idling again immediately does not run (count 0, last < 24h).
    const again = await scribe.onIdle();
    assert.equal(again.ran, false);
    assert.equal(again.reason, "gate-not-met");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: an explicit candidateSessionCount overrides persisted bookkeeping", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    // Persisted count is 0, but the caller asserts 10 ⇒ runs.
    const idle = await scribe.onIdle({ candidateSessionCount: 10 });
    assert.equal(idle.ran, true);
    assert.equal(idle.reason, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: the time threshold fires from the persisted lastConsolidatedAt", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    // Pretend the last consolidation was 25h ago (older than the 24h default).
    await markDreamConsolidated(root, Date.now() - 25 * 60 * 60 * 1000);
    const idle = await scribe.onIdle(); // no inputs — the time gate comes from persisted state
    assert.equal(idle.ran, true);
    assert.equal(idle.reason, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: runDream forces a pass regardless of the gate", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    const dream = await scribe.runDream(); // force = true
    assert.equal(dream.ran, true);
    assert.equal(dream.reason, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: a runner-failed pass does NOT reset the gate, so the next idle retries", async () => {
  const root = await tempRoot();
  try {
    const failing: DreamAgentRunner = async () => {
      throw new Error("boom");
    };
    const scribe = createMemScribe({ root, dreamRunner: failing });
    for (let i = 0; i < 5; i += 1) {
      await scribe.onSessionStart(`s${i}`);
      await scribe.onSessionEnd(`s${i}`);
    }
    const first = await scribe.onIdle(); // gate met (5 sessions), but the subagent throws
    assert.equal(first.ran, true);
    assert.equal(first.reason, "runner-failed");

    // Gate NOT advanced: counter preserved, no timestamp stamped.
    const st = await readDreamState(root);
    assert.equal(st.sessionsSince, 5);
    assert.equal(st.lastConsolidatedAt, null);

    // So idling again still runs (retry), not suppressed for a full window.
    const second = await scribe.onIdle();
    assert.equal(second.ran, true);
    assert.equal(second.reason, "runner-failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-dream gate: a disabled scribe never runs and never counts sessions", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root, enabled: false });
    await scribe.onSessionStart("s");
    await scribe.onSessionEnd("s"); // must not bump the gate on a disabled scribe
    const idle = await scribe.onIdle({ candidateSessionCount: 100 });
    assert.equal(idle.ran, false);
    assert.equal(idle.reason, "disabled");
    assert.deepEqual(await readDreamState(root), { lastConsolidatedAt: null, sessionsSince: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom cursorStore is used by extraction", async () => {
  const root = await tempRoot();
  try {
    const map = new Map<string, number>();
    const cursorStore = {
      get: (id: string) => (map.has(id) ? (map.get(id) as number) : null),
      set: (id: string, idx: number) => {
        map.set(id, idx);
      },
    };
    const { fn } = onceAgent({ type: "preference", name: "x", body: "User x." });
    const scribe = createMemScribe({ root, agent: fn, cursorStore });
    await scribe.onSessionStart("s1");
    await scribe.onTurnEnd("s1", userTurn("remember x"));

    assert.equal(map.get("s1"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onAgentEnd runs a final extraction sweep without a new turn", async () => {
  const root = await tempRoot();
  try {
    let payloadLen = 0;
    const fn: ExtractionAgentRunner = async ({ messages }) => {
      payloadLen = messages.length;
      return { changed: [] };
    };
    const scribe = createMemScribe({ root, agent: fn });
    await scribe.onSessionStart("s1");
    await scribe.onTurnEnd("s1", [
      { role: "user", text: "first message" },
      { role: "assistant", text: "reply" },
    ]);
    const end = await scribe.onAgentEnd("s1");
    assert.equal(end.result, ExtractionResult.Skipped);
    assert.equal(payloadLen, 2, "first sweep saw the cleaned user + assistant messages");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onSessionEnd drops session state", async () => {
  const root = await tempRoot();
  try {
    const scribe = createMemScribe({ root });
    await scribe.onSessionStart("s1");
    scribe.onTurnStart("s1");
    assert.ok(scribe.getSession("s1"));
    await scribe.onSessionEnd("s1");
    assert.equal(scribe.getSession("s1"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
