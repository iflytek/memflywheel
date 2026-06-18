import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSkillEvolutionAgent,
  validateSkillEvolutionCoordinationPacket,
  type LearnedSkillChangeSet,
  type SkillEvolutionStore,
  type SkillEvolutionTool,
} from "./skill-evolution-agent.js";
import { type ToolCompletion, type ToolCompletionResponse } from "./tool-completion.js";

function scriptedToolCompletion(responses: ToolCompletionResponse[]): {
  fn: ToolCompletion;
  requests: () => Parameters<ToolCompletion>[0][];
} {
  const seen: Parameters<ToolCompletion>[0][] = [];
  let i = 0;
  const fn: ToolCompletion = async (req) => {
    seen.push(req);
    const response = responses[i];
    i += 1;
    if (!response) throw new Error("unexpected skill evolution completion call");
    return response;
  };
  return { fn, requests: () => seen };
}

function toolCallResponse(name: string, args: unknown, id = "c1"): ToolCompletionResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls",
  };
}

const STOP_RESPONSE: ToolCompletionResponse = {
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
};

function makeStore(finalizeResult: LearnedSkillChangeSet): {
  store: SkillEvolutionStore;
  state: { checkpointed: number; finalized: number; rolledBack: number; toolCalls: string[] };
} {
  const state = { checkpointed: 0, finalized: 0, rolledBack: 0, toolCalls: [] as string[] };
  const tools: SkillEvolutionTool[] = [
    {
      name: "learned_skill_update",
      description: "Update exactly one learned skill.",
      inputSchema: {
        type: "object",
        properties: { skill: { type: "string" }, body: { type: "string" } },
        required: ["skill", "body"],
        additionalProperties: false,
      },
      handler: async (args) => {
        state.toolCalls.push(`learned_skill_update:${(args as { skill: string }).skill}`);
        return { ok: true, text: "updated" };
      },
    },
  ];
  return {
    state,
    store: {
      getLearnedSkillsCatalog: async ({ includeContent }) => ({
        includeContent,
        skills: [
          { id: "review-skill", name: "Review skill", relativePath: "review-skill/SKILL.md" },
          { id: "debug-skill", name: "Debug skill", relativePath: "debug-skill/SKILL.md" },
        ],
      }),
      createSkillCheckpoint: async () => {
        state.checkpointed += 1;
        return { id: `cp-${state.checkpointed}` };
      },
      finalizeLearnedSkillChanges: async () => {
        state.finalized += 1;
        return finalizeResult;
      },
      rollbackSkillCheckpoint: async () => {
        state.rolledBack += 1;
      },
      createSkillTools: () => tools,
    },
  };
}

test("runSkillEvolutionAgent: update decision must change exactly the target learned skill", async () => {
  const { store, state } = makeStore({
    changedSkills: ["review-skill"],
    changedFiles: ["review-skill/SKILL.md"],
  });
  const { fn, requests } = scriptedToolCompletion([
    toolCallResponse("learned_skill_update", { skill: "review-skill", body: "new body" }, "u1"),
    toolCallResponse(
      "skill_learn_decide",
      {
        decision: "update",
        targetSkill: "review-skill",
        why: "The review workflow recurred and was successfully reused.",
        memoryAction: "compress-memory",
        memoryTopics: ["code review workflow"],
        supportingFiles: ["review-skill/SKILL.md"],
      },
      "d1",
    ),
    STOP_RESPONSE,
  ]);

  const result = await runSkillEvolutionAgent({
    toolCompletion: fn,
    store,
    sessionId: "s1",
    reviewPacket: { summary: "review packet" },
    observedSkillUsages: [{ skill: "review-skill", outcome: "success" }],
    toolTrajectory: [{ name: "Bash", ok: true }],
    artifactPaths: ["packages/sdk/src/index.ts"],
    qualitySignals: { doneTurns: 3, toolCalls: 7 },
  });

  assert.equal(state.checkpointed, 1);
  assert.equal(state.finalized, 1);
  assert.equal(state.rolledBack, 0);
  assert.deepEqual(state.toolCalls, ["learned_skill_update:review-skill"]);
  assert.deepEqual(result.changedSkills, ["review-skill"]);
  assert.equal(result.coordination.decision, "update");
  assert.equal(result.coordination.memoryAction, "compress-memory");

  const seed = String(requests()[0].messages[1].content);
  assert.match(seed, /# Review packet/);
  assert.match(seed, /# Learned skill index/);
  assert.match(seed, /# Observed skill usages/);
  assert.match(seed, /# Tool trajectory/);
  assert.match(seed, /# Artifact paths/);
  assert.match(seed, /# Quality signals/);

  const specs = requests()[0].tools;
  assert.ok(specs.every((tool) => tool.function.strict === true));
  const decisionSpec = specs.find((tool) => tool.function.name === "skill_learn_decide");
  assert.ok(decisionSpec);
  assert.deepEqual(decisionSpec.function.parameters.required, [
    "decision",
    "targetSkill",
    "why",
    "memoryAction",
    "memoryTopics",
    "supportingFiles",
  ]);
});

test("runSkillEvolutionAgent: noop decision rejects any learned skill file change", async () => {
  const { store, state } = makeStore({
    changedSkills: ["review-skill"],
    changedFiles: ["review-skill/SKILL.md"],
  });
  const { fn } = scriptedToolCompletion([
    toolCallResponse(
      "skill_learn_decide",
      {
        decision: "noop",
        targetSkill: null,
        why: "No durable reusable method emerged.",
        memoryAction: "noop",
        memoryTopics: [],
        supportingFiles: [],
      },
      "d1",
    ),
    STOP_RESPONSE,
  ]);

  await assert.rejects(
    runSkillEvolutionAgent({
      toolCompletion: fn,
      store,
      sessionId: "s1",
      reviewPacket: { summary: "review packet" },
      observedSkillUsages: [],
      toolTrajectory: [],
      artifactPaths: [],
      qualitySignals: {},
    }),
    /noop decision changed learned skill files/,
  );
  assert.equal(state.rolledBack, 1);
});

test("runSkillEvolutionAgent: update decision rejects multiple learned skill changes", async () => {
  const { store, state } = makeStore({
    changedSkills: ["review-skill", "debug-skill"],
    changedFiles: ["review-skill/SKILL.md", "debug-skill/SKILL.md"],
  });
  const { fn } = scriptedToolCompletion([
    toolCallResponse(
      "skill_learn_decide",
      {
        decision: "update",
        targetSkill: "review-skill",
        why: "The review workflow recurred.",
        memoryAction: "compress-memory",
        memoryTopics: ["code review workflow"],
        supportingFiles: ["review-skill/SKILL.md"],
      },
      "d1",
    ),
    STOP_RESPONSE,
  ]);

  await assert.rejects(
    runSkillEvolutionAgent({
      toolCompletion: fn,
      store,
      sessionId: "s1",
      reviewPacket: { summary: "review packet" },
      observedSkillUsages: [],
      toolTrajectory: [],
      artifactPaths: [],
      qualitySignals: {},
    }),
    /must change exactly one learned skill/,
  );
  assert.equal(state.rolledBack, 1);
});

test("validateSkillEvolutionCoordinationPacket: hard-validates required enum fields", () => {
  assert.throws(
    () =>
      validateSkillEvolutionCoordinationPacket({
        decision: "update",
        targetSkill: "review-skill",
        why: "valid reason",
        memoryAction: "consolidate",
        memoryTopics: [],
        supportingFiles: [],
      }),
    /memoryAction/,
  );
});
