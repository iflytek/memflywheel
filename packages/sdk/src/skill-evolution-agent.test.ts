import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSkillEvolutionAgent,
  validateSkillEvolutionCoordination,
  validateSkillEvolutionChangeSet,
  type LearnedSkillChangeSet,
  type SkillEvolutionCoordination,
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
    message: { role: "assistant", content: null, toolCalls: [{ id, name, input: args }] },
    finishReason: "tool-calls",
  };
}

const STOP_RESPONSE: CanonicalModelResponse = {
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
};

/**
 * A mock store whose tools operate on an in-memory staged file map seeded from the
 * pre-existing catalog (mirroring how a real checkpoint stages a copy of skillsRoot).
 * The coordination is DERIVED from what the model actually changes — the model never
 * emits JSON — so the tools include a real glob/read/bash that the derivation reads.
 */
function makeStore(opts: { catalog?: string[]; finalizeResult: LearnedSkillChangeSet }): {
  store: SkillEvolutionStore;
  state: { checkpointed: number; finalized: number; rolledBack: number; toolCalls: string[]; files: Map<string, string> };
} {
  const catalog = opts.catalog ?? [];
  const files = new Map<string, string>();
  for (const name of catalog) files.set(`${name}/SKILL.md`, "existing body");
  const state = { checkpointed: 0, finalized: 0, rolledBack: 0, toolCalls: [] as string[], files };

  const tools: SkillEvolutionTool[] = [
    {
      name: "write",
      description: "Write a staged learned skill file.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" }, content: { type: "string" } },
        required: ["filePath", "content"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const filePath = (args as { filePath: string }).filePath;
        files.set(filePath, (args as { content: string }).content);
        state.toolCalls.push(`write:${filePath}`);
        return { ok: true, text: "written", changed: [filePath] };
      },
    },
    {
      name: "bash",
      description: "Run a shell command in the staged tree (e.g. rm -rf <dir>).",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const command = (args as { command: string }).command;
        state.toolCalls.push(`bash:${command}`);
        const rm = command.match(/rm\s+-rf\s+(\S+)/);
        if (rm) {
          const dir = rm[1]!.replace(/\/+$/, "");
          for (const key of [...files.keys()]) {
            if (key === dir || key.startsWith(`${dir}/`)) files.delete(key);
          }
        }
        return { ok: true, text: "ok" };
      },
    },
    {
      name: "glob",
      description: "Match staged files.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const pattern = (args as { pattern: string }).pattern;
        const suffix = pattern.replace(/^\*\//, "/");
        const matches = [...files.keys()].filter((key) => key.endsWith(suffix)).sort();
        return { ok: true, text: matches.length ? matches.join("\n") : "No files found" };
      },
    },
    {
      name: "read",
      description: "Read a staged file.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" }, limit: { type: "number" } },
        required: ["filePath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const content = files.get((args as { filePath: string }).filePath);
        if (content === undefined) return { ok: false, text: "File not found" };
        return { ok: true, text: content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join("\n") };
      },
    },
  ];

  return {
    state,
    store: {
      getLearnedSkillsCatalog: async ({ includeContent }) => ({
        includeContent,
        skills: catalog.map((name) => ({ name, relativePath: `${name}/SKILL.md` })),
      }),
      createSkillCheckpoint: async () => {
        state.checkpointed += 1;
        return { id: `cp-${state.checkpointed}` };
      },
      finalizeLearnedSkillChanges: async () => {
        state.finalized += 1;
        return opts.finalizeResult;
      },
      rollbackSkillCheckpoint: async () => {
        state.rolledBack += 1;
      },
      createFileTools: () => tools,
    },
  };
}

const REVIEW = "memscribe-learned-review";
const DEBUG = "memscribe-learned-debug";

function run(store: SkillEvolutionStore, model: CanonicalModelCompletion) {
  return runSkillEvolutionAgent({
    model,
    store,
    sessionId: "s1",
    reviewPacket: { summary: "review packet" },
    toolTrajectory: [{ name: "bash", ok: true }],
    artifactPaths: ["packages/sdk/src/index.ts"],
    qualitySignals: { doneTurns: 3, toolCalls: 7 },
  });
}

test("runSkillEvolutionAgent: a new skill file derives a create coordination (no JSON emitted)", async () => {
  const { store, state } = makeStore({ catalog: [], finalizeResult: { changedSkills: [REVIEW], changedFiles: [`${REVIEW}/SKILL.md`] } });
  const { model, requests } = scriptedModel([
    toolCallResponse("write", { filePath: `${REVIEW}/SKILL.md`, content: "new body" }, "u1"),
    STOP_RESPONSE,
  ]);

  const result = await run(store, model);

  assert.equal(state.checkpointed, 1);
  assert.equal(state.finalized, 1);
  assert.equal(state.rolledBack, 0);
  assert.deepEqual(result.changedSkills, [REVIEW]);
  assert.equal(result.coordination.decision, "create");
  assert.equal(result.coordination.targetSkill, REVIEW);
  // A real skill change links back to memory: dream compresses the redundant detail
  // into a cue. memoryAction defaults to compress-memory with a derived topic.
  assert.equal(result.coordination.memoryAction, "compress-memory");
  assert.ok(result.coordination.memoryTopics.length > 0);

  const seed = String(requests()[0].messages[1].content);
  for (const section of [/# Review packet/, /# Learned skill index/, /# Tool trajectory/, /# Artifact paths/, /# Quality signals/]) {
    assert.match(seed, section);
  }
  const specs = requests()[0].tools;
  assert.ok(specs.every((tool) => tool.strict === true));
  assert.ok(specs.some((tool) => tool.name === "write"));
});

test("runSkillEvolutionAgent: editing an existing catalog skill derives an update coordination", async () => {
  const { store, state } = makeStore({ catalog: [REVIEW], finalizeResult: { changedSkills: [REVIEW], changedFiles: [`${REVIEW}/SKILL.md`] } });
  const { model } = scriptedModel([
    toolCallResponse("write", { filePath: `${REVIEW}/SKILL.md`, content: "improved body" }, "u1"),
    STOP_RESPONSE,
  ]);

  const result = await run(store, model);

  assert.equal(state.rolledBack, 0);
  assert.equal(result.coordination.decision, "update");
  assert.equal(result.coordination.targetSkill, REVIEW);
});

test("runSkillEvolutionAgent: a skill change auto-links memory via a compress-memory coordination", async () => {
  const { store } = makeStore({ catalog: [REVIEW], finalizeResult: { changedSkills: [REVIEW], changedFiles: [`${REVIEW}/SKILL.md`] } });
  const { model } = scriptedModel([
    toolCallResponse("write", { filePath: `${REVIEW}/SKILL.md`, content: "improved" }, "u1"),
    STOP_RESPONSE,
  ]);

  const result = await run(store, model);

  // The memory↔skill link: a real skill change always triggers a follow-up memory
  // compression with a topic derived from the skill.
  assert.equal(result.coordination.decision, "update");
  assert.equal(result.coordination.memoryAction, "compress-memory");
  assert.deepEqual(result.coordination.memoryTopics, ["review"]);
});

test("runSkillEvolutionAgent: making no file change is a graceful noop, not a throw", async () => {
  const { store, state } = makeStore({ catalog: [], finalizeResult: { changedSkills: [], changedFiles: [] } });
  const { model } = scriptedModel([STOP_RESPONSE]);

  const result = await run(store, model);

  assert.equal(state.finalized, 1);
  assert.equal(state.rolledBack, 0);
  assert.equal(result.coordination.decision, "noop");
  assert.equal(result.coordination.targetSkill, null);
});

test("runSkillEvolutionAgent: deleting a duplicate directory derives a merge coordination", async () => {
  const { store, state } = makeStore({
    catalog: [REVIEW, DEBUG],
    finalizeResult: { changedSkills: [REVIEW, DEBUG], changedFiles: [`${REVIEW}/SKILL.md`] },
  });
  const { model } = scriptedModel([
    toolCallResponse("write", { filePath: `${REVIEW}/SKILL.md`, content: "merged body" }, "u1"),
    toolCallResponse("bash", { command: `rm -rf ${DEBUG}` }, "a1"),
    STOP_RESPONSE,
  ]);

  const result = await run(store, model);

  assert.equal(state.rolledBack, 0);
  assert.equal(result.coordination.decision, "merge");
  assert.equal(result.coordination.targetSkill, REVIEW);
  assert.deepEqual(result.coordination.mergedSkills, [DEBUG]);
  assert.deepEqual([...result.changedSkills].sort(), [DEBUG, REVIEW]);
});

test("runSkillEvolutionAgent: rolls back when the change set violates the one-skill invariant", async () => {
  const { store, state } = makeStore({
    catalog: [],
    finalizeResult: { changedSkills: [REVIEW, DEBUG], changedFiles: [`${REVIEW}/SKILL.md`, `${DEBUG}/SKILL.md`] },
  });
  const { model } = scriptedModel([
    toolCallResponse("write", { filePath: `${REVIEW}/SKILL.md`, content: "a" }, "u1"),
    toolCallResponse("write", { filePath: `${DEBUG}/SKILL.md`, content: "b" }, "u2"),
    STOP_RESPONSE,
  ]);

  await assert.rejects(run(store, model), /must change exactly one learned skill/);
  assert.equal(state.rolledBack, 1);
});

test("runSkillEvolutionAgent: feeds skill tool validation errors back so the model can correct them", async () => {
  const { store, state } = makeStore({ catalog: [], finalizeResult: { changedSkills: [REVIEW], changedFiles: [`${REVIEW}/SKILL.md`] } });
  // Reject any write that is not the canonical path, so the model must correct it.
  const writeTool = store.createFileTools({ id: "cp" }).find((tool) => tool.name === "write")!;
  const originalWrite = writeTool.handler;
  writeTool.handler = async (args) => {
    const filePath = (args as { filePath?: string }).filePath;
    if (filePath !== `${REVIEW}/SKILL.md`) return { ok: false, text: "filePath must be memscribe-learned-<slug>/SKILL.md" };
    return originalWrite(args);
  };
  const { model, requests } = scriptedModel([
    toolCallResponse("write", { filePath: "review/SKILL.md", content: "bad" }, "bad"),
    toolCallResponse("write", { filePath: `${REVIEW}/SKILL.md`, content: "good" }, "good"),
    STOP_RESPONSE,
  ]);

  const result = await run(store, model);

  assert.equal(state.rolledBack, 0);
  assert.equal(result.coordination.targetSkill, REVIEW);
  // the tool error was surfaced back to the model as a tool result
  assert.match(String(requests()[1].messages.at(-1)?.content), /memscribe-learned-<slug>\/SKILL\.md/);
});

test("validateSkillEvolutionChangeSet: enforces noop / one-skill / merge invariants", () => {
  const noopBase: Omit<SkillEvolutionCoordination, "decision"> = {
    targetSkill: null,
    mergedSkills: [],
    why: "x",
    memoryAction: "noop",
    memoryTopics: [],
    supportingFiles: [],
  };
  const compressBase: Omit<SkillEvolutionCoordination, "decision"> = {
    targetSkill: REVIEW,
    mergedSkills: [],
    why: "x",
    memoryAction: "compress-memory",
    memoryTopics: ["review"],
    supportingFiles: [],
  };
  assert.throws(
    () => validateSkillEvolutionChangeSet({ ...noopBase, decision: "noop" }, { changedSkills: [REVIEW], changedFiles: [`${REVIEW}/SKILL.md`] }),
    /noop decision changed learned skill files/,
  );
  assert.throws(
    () => validateSkillEvolutionChangeSet({ ...compressBase, decision: "create" }, { changedSkills: [REVIEW, DEBUG], changedFiles: [`${REVIEW}/SKILL.md`, `${DEBUG}/SKILL.md`] }),
    /must change exactly one learned skill/,
  );
  assert.throws(
    () => validateSkillEvolutionChangeSet({ ...compressBase, decision: "merge", mergedSkills: [DEBUG] }, { changedSkills: [REVIEW], changedFiles: [`${REVIEW}/SKILL.md`] }),
    /merge decision must change targetSkill and every mergedSkills entry/,
  );
});

test("validateSkillEvolutionCoordination: rejects an invalid memoryAction enum", () => {
  assert.throws(
    () =>
      validateSkillEvolutionCoordination({
        decision: "update",
        targetSkill: REVIEW,
        mergedSkills: [],
        why: "valid reason",
        memoryAction: "consolidate",
        memoryTopics: [],
        supportingFiles: [],
      }),
    /memoryAction/,
  );
});
