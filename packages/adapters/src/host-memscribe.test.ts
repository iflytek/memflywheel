import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createMemScribeHarnessRuntime } from "./host-memscribe.js";
import {
  type DreamAgentRunner,
  ExtractionResult,
  type ExtractionAgentRunner,
  type MemoryType,
} from "@memscribe/sdk";
import type { CanonicalModelCompletion, CanonicalModelResponse } from "@memscribe/model";
import { piAdapter } from "./pi.js";
import { createFakeHost, tempDir } from "./test-helpers.js";

const flush = () => new Promise((r) => setImmediate(r));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP: CanonicalModelResponse = {
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

function slug(name: string): string {
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
    filePath: `${input.type}/${input.filename ?? slug(input.name)}`,
    content: [
      "---",
      `type: ${input.type}`,
      `name: ${input.name}`,
      input.description ? `description: ${input.description}` : "description: ",
      "---",
      "",
      input.body,
      "",
    ].join("\n"),
  };
}

function workflowAgent(): ExtractionAgentRunner {
  let wrote = false;
  return async ({ tools, toolCtx }) => {
    if (wrote) return { changed: [] };
    wrote = true;
    const write = tools.find((tool) => tool.name === "write");
    assert.ok(write, "write tool is supplied to the agent");
    const result = await write.handler(
      writeMemoryArgs({
        type: "workflow",
        name: "release prep",
        description: "reusable release workflow",
        body: "Run package metadata checks, README checks, and dry-run pack checks.",
      }),
      toolCtx,
    );
    return { changed: result.changed ?? [] };
  };
}

/**
 * A scripted tool-calling subagent: on its first round it saves one preference
 * memory via the ordinary write tool; on every subsequent round it stops. This is
 * deterministic and offline — no network, no key.
 */
function savingModel(): CanonicalModelCompletion {
  let calls = 0;
  return {
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "c1",
                name: "write",
                input: writeMemoryArgs({
                  type: "preference",
                  name: "Preferred drink",
                  description: "User's go-to beverage",
                  body: "The user prefers green tea over coffee.",
                }),
              },
            ],
          },
          finishReason: "tool-calls",
        };
      }
      return STOP;
    },
  };
}

function toolCall(id: string, name: string, args: unknown) {
  return { id, name, input: args };
}

function learnedSkillLoopModel(): CanonicalModelCompletion {
  let extractionStep = 0;
  let skillStep = 0;
  let dreamStep = 0;
  return {
    complete: async (req) => {
    const toolNames = new Set(req.tools.map((tool) => tool.name));
    const system = req.messages.find((message) => message.role === "system")?.content ?? "";

    if (system.includes("learned-skill evolution agent")) {
      skillStep += 1;
      if (skillStep === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              toolCall("skill-write", "write", {
                filePath: `${TARGET_SKILL}/SKILL.md`,
                content: VALID_SKILL,
              }),
            ],
          },
          finishReason: "tool-calls",
        };
      }
      // The model is NOT required to emit any skill coordination — the decision is
      // derived from the file changes, and a real skill change automatically links back
      // to memory (memoryAction=compress-memory), triggering the follow-up dream pass.
      return STOP;
    }

    if (system.includes("consolidation engine")) {
      dreamStep += 1;
      if (dreamStep === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              toolCall("memory-read", "read", { filePath: "workflow/release-prep.md" }),
            ],
          },
          finishReason: "tool-calls",
        };
      }
      if (dreamStep === 2) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              toolCall("memory-update", "edit", {
                filePath: "workflow/release-prep.md",
                oldString: "Step 1: inspect metadata.\nStep 2: run CI.\nStep 3: scan public hygiene.",
                newString: `Release prep is handled by ${TARGET_SKILL}. Use that learned skill when release readiness comes up.`,
              }),
            ],
          },
          finishReason: "tool-calls",
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
            toolCalls: [
              toolCall("memory-save", "write", writeMemoryArgs({
                type: "workflow",
                name: "release prep",
                description: "reusable release workflow",
                body: "Step 1: inspect metadata.\nStep 2: run CI.\nStep 3: scan public hygiene.",
              })),
            ],
          },
          finishReason: "tool-calls",
        };
      }
      return STOP;
    }

    throw new Error(`unexpected tool request: ${[...toolNames].join(", ")}`);
    },
  };
}

/** A subagent that declines: it calls no tools and replies with one sentence. */
const decliningModel: CanonicalModelCompletion = { complete: async () => STOP };

test("createMemScribeHarnessRuntime with a canonical model extracts and writes a memory end-to-end", async () => {
  const root = await tempDir();
  const { scribe } = createMemScribeHarnessRuntime({ model: savingModel(), root });

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
  const { scribe } = createMemScribeHarnessRuntime({ model: savingModel(), root });
  const host = createFakeHost();
  const dispose = piAdapter.attach(scribe, host);

  host.emit("session_start", { sessionId: "s1" });
  host.emit("agent_end", {
    sessionId: "s1",
    messages: [
      { role: "user", content: "I always drink green tea, never coffee." },
      { role: "assistant", content: [{ type: "text", text: "Got it." }] },
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

test("createMemScribeHarnessRuntime prompt build returns the two recall segments", async () => {
  const root = await tempDir();
  const { scribe } = createMemScribeHarnessRuntime({ model: savingModel(), root });

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.equal(ctx.enabled, true);
  assert.ok(typeof ctx.systemPrompt === "string");
  assert.ok(typeof ctx.preludePrompt === "string");
});

test("createMemScribeHarnessRuntime wires skill recall and turn-end learning loop into the SDK", async () => {
  const root = await tempDir();
  const events: string[] = [];
  const dreamRunner: DreamAgentRunner = async ({ coordination }) => {
    events.push(`dream:${coordination?.memoryAction}:${coordination?.targetSkill}`);
    return { changed: [] };
  };
  const { scribe } = createMemScribeHarnessRuntime({
    root,
    agent: workflowAgent(),
    dreamRunner,
    skillRecall: async () => {
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
      skillEvolution: async ({ lastExtraction }) => {
        events.push(`skill:${lastExtraction.result}`);
        return {
          coordination: {
            decision: "update",
            targetSkill: "memscribe-learned-release-review",
            mergedSkills: [],
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

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.match(ctx.systemPrompt, /# 技能/);
  assert.match(ctx.preludePrompt, /## 可用技能/);
  assert.match(ctx.preludePrompt, /memscribe-learned-release-review/);
  assert.match(ctx.skillPreludePrompt ?? "", /Release Review/);

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
    "skill:completed",
    "dream:compress-memory:memscribe-learned-release-review",
  ]);
});

test("createMemScribeHarnessRuntime learnedSkills assembly runs extraction, skill evolution, dream, and recall", async () => {
  const root = await tempDir();
  const skillsRoot = path.join(root, "skills");
  const { scribe } = createMemScribeHarnessRuntime({
    root: path.join(root, "memory"),
    model: learnedSkillLoopModel(),
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

test("createMemScribeHarnessRuntime requires explicit recall-only mode when no model is present", async () => {
  const root = await tempDir();
  assert.throws(() => createMemScribeHarnessRuntime({ root }), /requires a canonical model/);

  const { scribe } = createMemScribeHarnessRuntime({ root, mode: "recall-only" });

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

test("createMemScribeHarnessRuntime decline (no tool calls) writes nothing", async () => {
  const root = await tempDir();
  const { scribe } = createMemScribeHarnessRuntime({ model: decliningModel, root });

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
  const { scribe } = createMemScribeHarnessRuntime({ model: savingModel(), root, enabled: false });

  await scribe.onSessionStart({ sessionId: "s1" });
  await scribe.onTurnEnd({
    sessionId: "s1",
    messages: [{ role: "user", text: "I always drink green tea." }],
  });

  const ctx = await scribe.onPromptBuild({ sessionId: "s1" });
  assert.equal(ctx.enabled, false);
  await assert.rejects(readFile(path.join(root, "MEMORY.md"), "utf8"), /ENOENT/);
});
