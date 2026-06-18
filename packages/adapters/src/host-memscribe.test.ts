import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createHostMemScribe, type ToolCompletion } from "./host-memscribe.js";
import {
  type DreamAgentRunner,
  ExtractionResult,
  type ExtractionAgentRunner,
  type SkillUsageRecord,
  type ToolCompletionResponse,
} from "@memscribe/sdk";
import { piAdapter } from "./pi.js";
import { createFakeHost, tempDir } from "./test-helpers.js";

const flush = () => new Promise((r) => setImmediate(r));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP: ToolCompletionResponse = {
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
};

const TARGET_SKILL = "memscribe-learned-release-review";
const VALID_SKILL = `---
name: memscribe-learned-release-review
display_name: Release Review
description: Captures a repeatable release preparation review.
---

## Use Cases

- Use when preparing a MemScribe package or repository release.

## Procedure

1. Inspect package metadata, package files, and publish configuration.
2. Inspect README, SECURITY, SUPPORT, CHANGELOG, and examples for release consistency.
3. Run the repository CI command and package dry-run.
4. Scan for old names, private paths, credentials, and AI-signature footers.
5. Summarize release blockers before opening a pull request.

## Guardrails

- Do not publish when secrets, private paths, or old project names are present.
- Keep release notes concise and evidence-based.
`;

function workflowAgent(): ExtractionAgentRunner {
  let wrote = false;
  return async ({ tools, toolCtx }) => {
    if (wrote) return { changed: [] };
    wrote = true;
    const save = tools.find((tool) => tool.name === "memory_save");
    assert.ok(save, "memory_save tool is supplied to the agent");
    const result = await save.handler(
      {
        type: "workflow",
        name: "release prep",
        description: "reusable release workflow",
        body: "Run package metadata checks, README checks, and dry-run pack checks.",
      },
      toolCtx,
    );
    return { changed: result.changed ?? [] };
  };
}

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

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function learnedSkillLoopToolCompletion(): ToolCompletion {
  let extractionStep = 0;
  let skillStep = 0;
  let dreamStep = 0;
  return async (req) => {
    const toolNames = new Set(req.tools.map((tool) => tool.function.name));
    const system = req.messages.find((message) => message.role === "system")?.content ?? "";

    if (toolNames.has("skill_write")) {
      skillStep += 1;
      if (skillStep === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("skill-write", "skill_write", {
                skillName: TARGET_SKILL,
                relativePath: "SKILL.md",
                content: VALID_SKILL,
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      if (skillStep === 2) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("skill-decide", "skill_learn_decide", {
                decision: "create",
                targetSkill: TARGET_SKILL,
                why: "Release preparation has become a reusable procedure.",
                memoryAction: "compress-memory",
                memoryTopics: ["release prep"],
                supportingFiles: [`${TARGET_SKILL}/SKILL.md`],
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return STOP;
    }

    if (system.includes("consolidation engine")) {
      dreamStep += 1;
      if (dreamStep === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("memory-read", "memory_read", { relativePath: "workflow/release-prep.md" }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      if (dreamStep === 2) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("memory-update", "memory_update", {
                relativePath: "workflow/release-prep.md",
                body: `Release prep is handled by ${TARGET_SKILL}. Use that learned skill when release readiness comes up.`,
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return STOP;
    }

    if (system.includes("memory extraction engine")) {
      extractionStep += 1;
      if (extractionStep === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("memory-save", "memory_save", {
                type: "workflow",
                name: "release prep",
                description: "reusable release workflow",
                body: "Step 1: inspect metadata.\nStep 2: run CI.\nStep 3: scan public hygiene.",
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return STOP;
    }

    throw new Error(`unexpected tool request: ${[...toolNames].join(", ")}`);
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

test("createHostMemScribe wires skill recall and turn-end learning loop into the SDK", async () => {
  const root = await tempDir();
  const seenUsageRecords: SkillUsageRecord[][] = [];
  const events: string[] = [];
  const dreamRunner: DreamAgentRunner = async ({ coordination }) => {
    events.push(`dream:${coordination?.memoryAction}:${coordination?.targetSkill}`);
    return { changed: [] };
  };
  const { scribe } = createHostMemScribe({
    root,
    agent: workflowAgent(),
    dreamRunner,
    skillRecall: async ({ usageRecords }) => {
      seenUsageRecords.push([...usageRecords]);
      return {
        entries: [
          {
            name: "memscribe-learned-release-review",
            displayName: "Release Review",
            description: "Review release readiness with a repeatable checklist.",
            relativePath: "memscribe-learned-release-review/SKILL.md",
            triggerHints: ["release prep"],
          },
        ],
      };
    },
    learningLoop: {
      enabled: true,
      source: "local",
      skillLearningEnabled: true,
      gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 1 },
      skillEvolution: async ({ usageRecords, lastExtraction }) => {
        events.push(`skill:${lastExtraction.result}:${usageRecords.length}`);
        return {
          coordination: {
            decision: "update",
            targetSkill: "memscribe-learned-release-review",
            why: "Release prep has become reusable.",
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

  scribe.recordSkillUsage({
    sessionId: "s1",
    skillName: "memscribe-learned-release-review",
    outcome: "completed",
    trigger: "release prep",
  });

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.match(ctx.systemPrompt, /# 技能/);
  assert.match(ctx.preludePrompt, /## 可用技能/);
  assert.match(ctx.preludePrompt, /memscribe-learned-release-review/);
  assert.match(ctx.skillPreludePrompt ?? "", /Release Review/);
  assert.equal(seenUsageRecords[0]?.[0]?.outcome, "completed");

  const result = await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [
      {
        role: "assistant",
        text: "release prep done",
        toolCalls: [{ name: "pnpm", input: { command: "pnpm run ci" }, output: "ok" }],
      },
    ],
  });
  assert.equal(result.result, ExtractionResult.Completed);
  assert.equal(result.learningLoop?.extraction.ran, true);
  assert.equal(result.learningLoop?.skillEvolution.ran, true);
  assert.equal(result.learningLoop?.dream.ran, true);
  assert.deepEqual(events, [
    "skill:completed:1",
    "dream:compress-memory:memscribe-learned-release-review",
  ]);
});

test("createHostMemScribe learnedSkills assembly runs extraction, skill evolution, dream, and recall", async () => {
  const root = await tempDir();
  const skillsRoot = path.join(root, "skills");
  const { scribe } = createHostMemScribe({
    root: path.join(root, "memory"),
    toolCompletion: learnedSkillLoopToolCompletion(),
    learnedSkills: {
      skillsRoot,
      checkpointRoot: path.join(root, ".skill-checkpoints"),
      maxSteps: 8,
      reviewPacket: ({ lastExtraction, session }) => ({
        goal: `Create ${TARGET_SKILL} from the release prep workflow memory.`,
        requiredTargetSkill: TARGET_SKILL,
        lastExtraction,
        messages: session.messages,
      }),
      qualitySignals: () => ({
        repeatedWorkflow: true,
        shouldBecomeSkill: true,
        requiredTargetSkill: TARGET_SKILL,
      }),
    },
    learningLoop: {
      gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 1 },
    },
  });

  await scribe.onSessionStart({ sessionId: "s1" });
  const result = await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [
      { role: "user", text: "release prep is repeated enough to learn" },
      {
        role: "assistant",
        text: "I ran release prep.",
        toolCalls: [{ name: "pnpm", input: { command: "pnpm run ci" }, output: "ok" }],
      },
    ],
  });

  assert.equal(result.result, ExtractionResult.Completed);
  assert.equal(result.learningLoop?.extraction.ran, true);
  assert.equal(result.learningLoop?.skillEvolution.ran, true);
  assert.equal(result.learningLoop?.dream.ran, true);

  const skillFile = await readFile(path.join(skillsRoot, TARGET_SKILL, "SKILL.md"), "utf8");
  assert.match(skillFile, /## Procedure/);
  const memoryFile = await readFile(path.join(root, "memory", "workflow", "release-prep.md"), "utf8");
  assert.match(memoryFile, new RegExp(TARGET_SKILL));
  assert.doesNotMatch(memoryFile, /Step 1:/);

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.match(ctx.preludePrompt, new RegExp(TARGET_SKILL));
  assert.match(ctx.skillPreludePrompt ?? "", /Release Review/);
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
