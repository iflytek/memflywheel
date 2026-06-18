#!/usr/bin/env node
/**
 * Learned-skill loop regression.
 *
 * USE_FAKE=1 is deterministic and runs in the default example smoke suite.
 * Without USE_FAKE, the script calls a real OpenAI-compatible tool-calling model
 * through MEMSCRIBE_LLM_* env vars and fails if the model does not perform the
 * required tool calls.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanMemoryFiles } from "@memscribe/core";
import { createToolCompletion } from "@memscribe/sdk";
import { createHostMemScribe } from "@memscribe/adapters";

const TARGET_SKILL = "memscribe-learned-release-review";
const MEMORY_PATH = "workflow/release-prep-workflow.md";
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

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`missing ${name}`);
  }
  return value.trim();
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function createFakeLearningToolCompletion() {
  let extractionStep = 0;
  let skillStep = 0;
  let dreamStep = 0;
  return async (req) => {
    const toolNames = new Set(req.tools.map((tool) => tool.function.name));
    const system = req.messages.find((message) => message.role === "system")?.content ?? "";

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
                name: "release prep workflow",
                description: "Reusable release preparation procedure that should become a learned skill.",
                body: [
                  "Step 1: inspect package metadata, package files, and publish configuration.",
                  "Step 2: inspect README, SECURITY, SUPPORT, CHANGELOG, and examples for release consistency.",
                  "Step 3: run the repository CI command and package dry-run.",
                  "Step 4: scan for old names, private paths, credentials, and AI-signature footers.",
                  "Step 5: summarize release blockers before opening a pull request.",
                ].join("\n"),
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }

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
                memoryTopics: ["release prep workflow"],
                supportingFiles: [`${TARGET_SKILL}/SKILL.md`],
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }

    if (system.includes("consolidation engine")) {
      dreamStep += 1;
      if (dreamStep === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("memory-read", "memory_read", { relativePath: MEMORY_PATH }),
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
                relativePath: MEMORY_PATH,
                body: `Release prep workflow is now handled by ${TARGET_SKILL}. Use that learned skill when release readiness comes up.`,
              }),
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }

    throw new Error(`unexpected tool set: ${[...toolNames].join(", ")}`);
  };
}

const skillEvolutionSystemPrompt = `You are running a MemScribe real learned-skill regression. You must create exactly one learned skill named ${TARGET_SKILL}.

# Required behavior

1. Use skill_write with skillName="${TARGET_SKILL}" and relativePath="SKILL.md".
2. The SKILL.md file must use strict frontmatter with exactly name, display_name, description.
3. The SKILL.md body must include ## Use Cases, ## Procedure, and ## Guardrails.
4. The Procedure section must use contiguous numbered steps starting at 1.
5. After writing SKILL.md, call skill_learn_decide exactly once.

# Tool-call format

Every tool call argument must be a strict JSON object accepted by the provided
function schema. Do not put Markdown, code fences, comments, YAML, trailing
commas, or explanatory text inside the function arguments.

For skill_write, skillName is the learned skill directory name and relativePath
is a path inside that directory. Therefore the only correct SKILL.md write is:
{"skillName":"${TARGET_SKILL}","relativePath":"SKILL.md","content":"..."}.
Never set relativePath to "${TARGET_SKILL}/SKILL.md".

# Required decision packet

The skill_learn_decide arguments must be exactly this strict JSON object shape:

{"decision":"create","targetSkill":"${TARGET_SKILL}","why":"Release preparation has become a reusable procedure.","memoryAction":"compress-memory","memoryTopics":["release prep workflow"],"supportingFiles":["${TARGET_SKILL}/SKILL.md"]}

targetSkill is mandatory for decision="create". It must be the exact non-empty
string "${TARGET_SKILL}". Never set targetSkill to null, empty string, or any
other name.

Do not write any other learned skill. Do not call noop.`;

async function main() {
  const useFake = process.env.USE_FAKE === "1";
  const endpoint = useFake ? "fake" : requireEnv("MEMSCRIBE_LLM_ENDPOINT");
  const model = useFake ? "fake-learning-loop" : requireEnv("MEMSCRIBE_LLM_MODEL");
  const root = process.env.MEMSCRIBE_EXAMPLE_ROOT
    ? path.resolve(process.env.MEMSCRIBE_EXAMPLE_ROOT)
    : await mkdtemp(path.join(tmpdir(), "memscribe-real-loop-"));
  const memoryRoot = path.join(root, "memory");
  const skillsRoot = path.join(root, "skills");
  const checkpointRoot = path.join(root, ".skill-checkpoints");

  const rawToolCompletion = useFake
    ? createFakeLearningToolCompletion()
    : createToolCompletion({
        endpoint,
        model,
        maxTokens: Number.parseInt(process.env.MEMSCRIBE_LLM_MAX_TOKENS ?? "4096", 10),
      });
  const toolCompletion = async (req) => {
    const response = await rawToolCompletion(req);
    if (process.env.MEMSCRIBE_DEBUG_TOOL_ARGS === "1") {
      for (const call of response.message.tool_calls ?? []) {
        if (call.function.name === "skill_learn_decide") {
          console.error(`[debug] skill_learn_decide arguments: ${call.function.arguments}`);
        }
      }
    }
    return response;
  };
  const { scribe, sdk } = createHostMemScribe({
    root: memoryRoot,
    toolCompletion,
    learnedSkills: {
      skillsRoot,
      checkpointRoot,
      systemPrompt: skillEvolutionSystemPrompt,
      maxSteps: 8,
      reviewPacket: ({ lastExtraction, session }) => ({
        goal: `Create ${TARGET_SKILL} from the release prep workflow memory.`,
        requiredTargetSkill: TARGET_SKILL,
        memoryTopic: "release prep workflow",
        lastExtraction,
        messages: session.messages,
      }),
      toolTrajectory: ({ session }) =>
        session.messages.flatMap((message) =>
          (message.toolCalls ?? []).map((call) => ({
            name: call.name,
            input: call.input,
            output: call.output,
          })),
        ),
      artifactPaths: () => ["README.md", "docs/skill-learning.md", "packages/sdk/src/index.ts"],
      qualitySignals: () => ({
        repeatedWorkflow: true,
        shouldBecomeSkill: true,
        requiredTargetSkill: TARGET_SKILL,
      }),
    },
    learningLoop: {
      enabled: true,
      source: "local",
      skillLearningEnabled: true,
      gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 1 },
    },
  });

  await scribe.onSessionStart({ sessionId: "real-loop" });
  scribe.recordSkillUsage({
    sessionId: "real-loop",
    skillName: TARGET_SKILL,
    outcome: "missed",
    trigger: "release prep workflow",
    note: "No learned skill existed before this regression turn.",
  });
  const result = await scribe.onTurnEnd({
    sessionId: "real-loop",
    messages: [
      {
        role: "user",
        text: "We repeated the release prep workflow again; turn it into a reusable learned skill.",
      },
      {
        role: "assistant",
        text: "I ran the release prep checks.",
        toolCalls: [
          { name: "pnpm", input: { command: "pnpm run ci" }, output: "ok" },
          { name: "secret-scan", input: { command: "rg secret" }, output: "ok" },
        ],
      },
    ],
  });

  assert.equal(result.learningLoop?.extraction.ran, true, "extraction ran");
  assert.equal(result.learningLoop?.skillEvolution.ran, true, "skill evolution ran");
  assert.equal(result.learningLoop?.dream.ran, true, "dream ran");

  const skillFile = await readFile(path.join(skillsRoot, TARGET_SKILL, "SKILL.md"), "utf8");
  assert.match(skillFile, new RegExp(`name: ${TARGET_SKILL}`));
  assert.match(skillFile, /## Procedure/);

  const workflowEntries = (await scanMemoryFiles(memoryRoot)).filter((entry) => entry.type === "workflow");
  assert.equal(workflowEntries.length, 1, "one workflow memory exists");
  const memoryPath = workflowEntries[0].relativePath;
  const memory = await sdk.read(memoryPath);
  assert.ok(memory, `${memoryPath} exists`);
  assert.match(memory.body, new RegExp(TARGET_SKILL));
  assert.doesNotMatch(memory.body, /Step 1:/);
  assert.doesNotMatch(memory.body, /Step 5:/);

  const prompt = await scribe.onPromptBuild({ sessionId: "real-loop" });
  assert.match(prompt.preludePrompt, new RegExp(TARGET_SKILL));

  console.log(JSON.stringify({
    ok: true,
    mode: useFake ? "fake" : "real",
    root,
    model,
    memoryPath,
    targetSkill: TARGET_SKILL,
    skillBytes: skillFile.length,
    memoryBody: memory.body,
  }, null, 2));
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
