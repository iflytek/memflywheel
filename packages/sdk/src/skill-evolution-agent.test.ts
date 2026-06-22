import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSkillEvolutionAgent,
  validateSkillEvolutionCoordinationPacket,
  type LearnedSkillChangeSet,
  type SkillEvolutionStore,
  type SkillEvolutionTool,
} from "./skill-evolution-agent.js";
import type {
  CanonicalModelCompletion,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "@memscribe/model";

function scriptedModel(responses: CanonicalModelResponse[]): {
  model: CanonicalModelCompletion;
  requests: () => CanonicalModelRequest[];
} {
  const seen: CanonicalModelRequest[] = [];
  let i = 0;
  const model: CanonicalModelCompletion = {
    complete: async (req) => {
      seen.push({
        ...req,
        messages: req.messages.map((message) => ({
          ...message,
          toolCalls: message.toolCalls?.map((call) => ({ ...call })),
        })),
        tools: req.tools.map((tool) => ({ ...tool })),
      });
      const response = responses[i];
      i += 1;
      if (!response) throw new Error("unexpected skill evolution completion call");
      return response;
    },
  };
  return { model, requests: () => seen };
}

function toolCallResponse(name: string, args: unknown, id = "c1"): CanonicalModelResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [{ id, name, input: args }],
    },
    finishReason: "tool-calls",
  };
}

function finalCoordinationResponse(packet: unknown): CanonicalModelResponse {
  return {
    message: { role: "assistant", content: JSON.stringify(packet) },
    finishReason: "stop",
  };
}

const NON_JSON_STOP_RESPONSE: CanonicalModelResponse = {
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
      name: "write",
      description: "Update exactly one learned skill.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" }, content: { type: "string" } },
        required: ["filePath", "content"],
        additionalProperties: false,
      },
      handler: async (args) => {
        state.toolCalls.push(`write:${(args as { filePath: string }).filePath}`);
        return { ok: true, text: "updated" };
      },
    },
    {
      name: "bash",
      description: "Archive one learned skill.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      handler: async (args) => {
        state.toolCalls.push(`bash:${(args as { command: string }).command}`);
        return { ok: true, text: "archived" };
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
      createFileTools: () => tools,
    },
  };
}

test("runSkillEvolutionAgent: update decision must change exactly the target learned skill", async () => {
  const { store, state } = makeStore({
    changedSkills: ["review-skill"],
    changedFiles: ["review-skill/SKILL.md"],
  });
  const { model, requests } = scriptedModel([
    toolCallResponse("write", { filePath: "review-skill/SKILL.md", content: "new body" }, "u1"),
    finalCoordinationResponse({
        decision: "update",
        targetSkill: "review-skill",
        mergedSkills: [],
        why: "The review workflow recurred and was successfully reused.",
        memoryAction: "compress-memory",
        memoryTopics: ["code review workflow"],
        supportingFiles: ["review-skill/SKILL.md"],
    }),
  ]);

  const result = await runSkillEvolutionAgent({
    model,
    store,
    sessionId: "s1",
    reviewPacket: { summary: "review packet" },
    toolTrajectory: [{ name: "Bash", ok: true }],
    artifactPaths: ["packages/sdk/src/index.ts"],
    qualitySignals: { doneTurns: 3, toolCalls: 7 },
  });

  assert.equal(state.checkpointed, 1);
  assert.equal(state.finalized, 1);
  assert.equal(state.rolledBack, 0);
  assert.deepEqual(state.toolCalls, ["write:review-skill/SKILL.md"]);
  assert.deepEqual(result.changedSkills, ["review-skill"]);
  assert.equal(result.coordination.decision, "update");
  assert.equal(result.coordination.memoryAction, "compress-memory");

  const seed = String(requests()[0].messages[1].content);
  assert.match(seed, /# Review packet/);
  assert.match(seed, /# Learned skill index/);
  assert.match(seed, /# Tool trajectory/);
  assert.match(seed, /# Artifact paths/);
  assert.match(seed, /# Quality signals/);

  const specs = requests()[0].tools;
  assert.ok(specs.every((tool) => tool.strict === true));
  assert.deepEqual(specs.map((tool) => tool.name).sort(), ["bash", "write"]);
  assert.ok(!specs.some((tool) => tool.name.startsWith("skill_")));
});

test("runSkillEvolutionAgent: noop decision rejects any learned skill file change", async () => {
  const { store, state } = makeStore({
    changedSkills: ["review-skill"],
    changedFiles: ["review-skill/SKILL.md"],
  });
  const { model } = scriptedModel([
    finalCoordinationResponse({
        decision: "noop",
        targetSkill: null,
        mergedSkills: [],
        why: "No durable reusable method emerged.",
        memoryAction: "noop",
        memoryTopics: [],
        supportingFiles: [],
    }),
  ]);

  await assert.rejects(
    runSkillEvolutionAgent({
      model,
      store,
      sessionId: "s1",
      reviewPacket: { summary: "review packet" },
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
  const { model } = scriptedModel([
    finalCoordinationResponse({
        decision: "update",
        targetSkill: "review-skill",
        mergedSkills: [],
        why: "The review workflow recurred.",
        memoryAction: "compress-memory",
        memoryTopics: ["code review workflow"],
        supportingFiles: ["review-skill/SKILL.md"],
    }),
  ]);

  await assert.rejects(
    runSkillEvolutionAgent({
      model,
      store,
      sessionId: "s1",
      reviewPacket: { summary: "review packet" },
      toolTrajectory: [],
      artifactPaths: [],
      qualitySignals: {},
    }),
    /must change exactly one learned skill/,
  );
  assert.equal(state.rolledBack, 1);
});

test("runSkillEvolutionAgent: merge decision must change target and archived duplicate skills", async () => {
  const { store, state } = makeStore({
    changedSkills: ["review-skill", "debug-skill"],
    changedFiles: ["review-skill/SKILL.md", "debug-skill/SKILL.md"],
  });
  const { model } = scriptedModel([
    toolCallResponse("write", { filePath: "review-skill/SKILL.md", content: "merged body" }, "u1"),
    toolCallResponse("bash", { command: "rm -rf debug-skill" }, "a1"),
    finalCoordinationResponse({
        decision: "merge",
        targetSkill: "review-skill",
        mergedSkills: ["debug-skill"],
        why: "The debug workflow duplicated the review workflow and was merged.",
        memoryAction: "compress-memory",
        memoryTopics: ["code review workflow"],
        supportingFiles: ["review-skill/SKILL.md"],
    }),
  ]);

  const result = await runSkillEvolutionAgent({
    model,
    store,
    sessionId: "s1",
    reviewPacket: { summary: "review packet" },
    toolTrajectory: [{ name: "Bash", ok: true }],
    artifactPaths: [],
    qualitySignals: { doneTurns: 4, toolCalls: 3 },
  });

  assert.deepEqual(state.toolCalls, [
    "write:review-skill/SKILL.md",
    "bash:rm -rf debug-skill",
  ]);
  assert.equal(state.rolledBack, 0);
  assert.equal(result.coordination.decision, "merge");
  assert.deepEqual(result.coordination.mergedSkills, ["debug-skill"]);
  assert.deepEqual(result.changedSkills.sort(), ["debug-skill", "review-skill"]);
});

test("runSkillEvolutionAgent: feeds skill tool validation errors back so the model can correct them", async () => {
  const state = { checkpointed: 0, finalized: 0, rolledBack: 0, toolCalls: [] as string[] };
  const store: SkillEvolutionStore = {
    getLearnedSkillsCatalog: async () => ({ skills: [] }),
    createSkillCheckpoint: async () => {
      state.checkpointed += 1;
      return { id: "cp" };
    },
    finalizeLearnedSkillChanges: async () => {
      state.finalized += 1;
      return {
        changedSkills: ["memscribe-learned-release-runbook"],
        changedFiles: ["memscribe-learned-release-runbook/SKILL.md"],
      };
    },
    rollbackSkillCheckpoint: async () => {
      state.rolledBack += 1;
    },
    createFileTools: () => [
      {
        name: "write",
        description: "Write one learned skill file.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            content: { type: "string" },
          },
          required: ["filePath", "content"],
          additionalProperties: false,
        },
        handler: async (args) => {
          const filePath = (args as { filePath?: string }).filePath;
          state.toolCalls.push(`write:${filePath}`);
          if (filePath !== "memscribe-learned-release-runbook/SKILL.md") {
            return { ok: false, text: "filePath must be memscribe-learned-<slug>/SKILL.md" };
          }
          return { ok: true, text: "wrote memscribe-learned-release-runbook/SKILL.md" };
        },
      },
    ],
  };
  const { model, requests } = scriptedModel([
    toolCallResponse(
      "write",
      { filePath: "release-runbook/SKILL.md", content: "bad" },
      "bad",
    ),
    toolCallResponse(
      "write",
      {
        filePath: "memscribe-learned-release-runbook/SKILL.md",
        content: "good",
      },
      "good",
    ),
    finalCoordinationResponse({
        decision: "create",
        targetSkill: "memscribe-learned-release-runbook",
        mergedSkills: [],
        why: "The release procedure is reusable.",
        memoryAction: "compress-memory",
        memoryTopics: ["release runbook"],
        supportingFiles: ["memscribe-learned-release-runbook/SKILL.md"],
    }),
  ]);

  const result = await runSkillEvolutionAgent({
    model,
    store,
    sessionId: "s1",
    reviewPacket: { summary: "release workflow" },
    toolTrajectory: [{ name: "bash", output: "ok" }],
    artifactPaths: [],
    qualitySignals: { doneTurns: 3, toolCalls: 1 },
  });

  assert.deepEqual(state.toolCalls, [
    "write:release-runbook/SKILL.md",
    "write:memscribe-learned-release-runbook/SKILL.md",
  ]);
  assert.equal(state.finalized, 1);
  assert.equal(state.rolledBack, 0);
  assert.equal(result.coordination.targetSkill, "memscribe-learned-release-runbook");
  assert.match(String(requests()[1].messages.at(-1)?.content), /memscribe-learned-<slug>\/SKILL\.md/);
});

test("validateSkillEvolutionCoordinationPacket: hard-validates required enum fields", () => {
  assert.throws(
    () =>
      validateSkillEvolutionCoordinationPacket({
        decision: "update",
        targetSkill: "review-skill",
        mergedSkills: [],
        why: "valid reason",
        memoryAction: "consolidate",
        memoryTopics: [],
        supportingFiles: [],
      }),
    /memoryAction/,
  );
});
