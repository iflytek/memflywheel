/**
 * Learned-skill evolution runner.
 *
 * This mirrors extraction/dream at the SDK layer: the SDK owns the model loop and
 * the skill package owns file mutations through its tools. The runner wraps the
 * pass in a skill checkpoint, requires an explicit coordination packet, finalizes
 * the checkpoint, then hard-validates that the packet and actual changed skills
 * agree.
 */

import { clampSteps } from "./tool-agent.js";
import type {
  CanonicalModelCompletion,
  CanonicalModelMessage,
  CanonicalToolDefinition,
  JsonSchemaObject,
} from "@memscribe/model";

const DEFAULT_MAX_STEPS = 12;
const MAX_TOOL_RESULT_CHARS = 4000;

export const DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT = `You are a learned-skill evolution agent. Your job is to improve durable executable methods by editing learned skills through ordinary file tools, then return exactly one final coordination packet as raw JSON.

# Scope

Review the supplied packet, learned skill index, tool trajectory, artifact paths, and quality signals. Decide whether a reusable method should become a learned skill, update an existing learned skill, merge duplicate learned skills, or stay as no change.

# Rules

- Use only the provided ordinary file tools: read, write, edit, bash, glob, grep.
- All tool paths are relative to the staged learned-skills root.
- decision=create or decision=update must change exactly one learned skill: the targetSkill named in the coordination packet.
- decision=merge must write the merged content into targetSkill and delete every redundant skill directory listed in mergedSkills.
- targetSkill and every learned skill directory must match memscribe-learned-<slug>. If the observed skill name is "release-runbook", convert it to "memscribe-learned-release-runbook" before writing files or deciding.
- A created/updated/merged target learned skill package is invalid unless you write a non-empty SKILL.md at "<targetSkill>/SKILL.md". Supporting files under references/, scripts/, templates/, or assets/ are optional and never replace SKILL.md.
- SKILL.md must start with strict YAML frontmatter containing exactly name, display_name, and description. The name value must equal targetSkill.
- SKILL.md must include these sections: "## Use Cases", "## Procedure", and "## Guardrails". Procedure steps must be numbered with "1.", "2.", etc., not bullets.
- decision=noop must not change any learned skill files.
- Do not write memory files. If memory should be compressed after a skill update, set memoryAction=compress-memory and list the memoryTopics.
- Keep public names generic; do not leak host project names into learned skills unless they are part of the user's actual requested skill.
- If there is no durable reusable method, make no file changes and return a noop coordination packet.

# Valid SKILL.md shape

Use this structure for the required SKILL.md entrypoint, replacing names and content with the actual skill:

---
name: memscribe-learned-release-runbook
display_name: Release Runbook
description: Reusable procedure for safely running a release.
---

## Use Cases

- Run this when the user asks to publish, release, or cut a version.

## Procedure

1. Build the workspace and stop on failure.
2. Run the full test suite and stop on failure.
3. Update release notes or changelog.
4. Publish using the approved package command.
5. Create and push the release tag.

## Guardrails

- Do not publish when build or tests fail.
- Do not write secrets or private credentials into files.

# Required final coordination packet

After all file changes are done, stop calling tools and make your final assistant content exactly this JSON object with no markdown fence and no surrounding prose:
- decision: create | update | merge | noop
- targetSkill: string for create/update/merge, null for noop
- mergedSkills: string[]; non-empty only for merge
- why: concise reason
- memoryAction: compress-memory | noop
- memoryTopics: string[]
- supportingFiles: string[]`;

export const LEARNED_SKILL_MD_TEMPLATE = `---
name: memscribe-learned-release-runbook
display_name: Release Runbook
description: Reusable procedure for safely running a release.
---

## Use Cases

- Run this when the user asks to publish, release, or cut a version.

## Procedure

1. Build the workspace and stop on failure.
2. Run the full test suite and stop on failure.
3. Update release notes or changelog.
4. Publish using the approved package command.
5. Create and push the release tag.

## Guardrails

- Do not publish when build or tests fail.
- Do not write secrets or private credentials into files.
`;

export type SkillEvolutionDecision = "create" | "update" | "merge" | "noop";
export type SkillEvolutionMemoryAction = "compress-memory" | "noop";

export interface SkillEvolutionCoordinationPacket {
  decision: SkillEvolutionDecision;
  targetSkill: string | null;
  mergedSkills: string[];
  why: string;
  memoryAction: SkillEvolutionMemoryAction;
  memoryTopics: string[];
  supportingFiles: string[];
}

export interface SkillEvolutionToolResult {
  ok: boolean;
  text: string;
  changed?: string[];
}

export interface SkillEvolutionTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject | {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: unknown) => Promise<SkillEvolutionToolResult>;
}

export type SkillCheckpoint = unknown;

export interface LearnedSkillsCatalog {
  skills: unknown[];
}

export interface LearnedSkillChangeSet {
  changedSkills: string[];
  changedFiles: string[];
}

export interface SkillEvolutionLearningSummary {
  coordination: SkillEvolutionCoordinationPacket;
  reviewPacket: unknown;
  toolTrajectory: unknown;
  artifactPaths: string[];
  qualitySignals: unknown;
}

export interface SkillEvolutionStore<TCheckpoint = unknown> {
  getLearnedSkillsCatalog(input: { includeContent?: boolean }): Promise<LearnedSkillsCatalog>;
  createSkillCheckpoint(): Promise<TCheckpoint>;
  finalizeLearnedSkillChanges(input: {
    checkpoint: TCheckpoint;
    sessionId: string;
    learningSummary: SkillEvolutionLearningSummary;
  }): Promise<LearnedSkillChangeSet>;
  rollbackSkillCheckpoint(checkpoint: TCheckpoint): Promise<void>;
  createFileTools(checkpoint: TCheckpoint): SkillEvolutionTool[];
}

export interface RunSkillEvolutionAgentOptions<TCheckpoint = unknown> {
  model: CanonicalModelCompletion;
  store: SkillEvolutionStore<TCheckpoint>;
  sessionId: string;
  reviewPacket: unknown;
  toolTrajectory: unknown;
  artifactPaths: string[];
  qualitySignals: unknown;
  includeSkillContent?: boolean;
  systemPrompt?: string;
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface SkillEvolutionAgentResult extends LearnedSkillChangeSet {
  coordination: SkillEvolutionCoordinationPacket;
  learnedSkillIndex: LearnedSkillsCatalog;
  toolCalls: string[];
  stoppedReason: "no-tool-calls" | "max-steps" | "aborted";
  steps: number;
}

function clipToolResult(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...(truncated)`
    : text;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`${label} has invalid keys: ${actual.join(",")}`);
  }
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${label} must contain only non-empty strings`);
    }
  }
  return [...value];
}

export function validateSkillEvolutionCoordinationPacket(
  value: unknown,
): SkillEvolutionCoordinationPacket {
  const record = assertRecord(value, "coordination packet");
  assertExactKeys(
    record,
    ["decision", "targetSkill", "mergedSkills", "why", "memoryAction", "memoryTopics", "supportingFiles"],
    "coordination packet",
  );

  const decision = record.decision;
  if (decision !== "create" && decision !== "update" && decision !== "merge" && decision !== "noop") {
    throw new Error("coordination packet decision must be create, update, merge, or noop");
  }

  const targetSkill = record.targetSkill;
  if (decision === "noop") {
    if (targetSkill !== null) {
      throw new Error("coordination packet targetSkill must be null for noop");
    }
  } else if (typeof targetSkill !== "string" || targetSkill.trim() === "") {
    throw new Error("coordination packet targetSkill must be a non-empty string");
  }

  if (typeof record.why !== "string" || record.why.trim() === "") {
    throw new Error("coordination packet why must be a non-empty string");
  }

  const mergedSkills = assertStringArray(record.mergedSkills, "coordination packet mergedSkills");
  if (decision === "merge") {
    if (mergedSkills.length === 0) {
      throw new Error("coordination packet merge decision must declare mergedSkills");
    }
    if (mergedSkills.includes(targetSkill as string)) {
      throw new Error("coordination packet mergedSkills must not include targetSkill");
    }
  } else if (mergedSkills.length > 0) {
    throw new Error("coordination packet mergedSkills is only allowed for merge");
  }

  const memoryAction = record.memoryAction;
  if (memoryAction !== "compress-memory" && memoryAction !== "noop") {
    throw new Error("coordination packet memoryAction must be compress-memory or noop");
  }

  const memoryTopics = assertStringArray(record.memoryTopics, "coordination packet memoryTopics");
  const supportingFiles = assertStringArray(record.supportingFiles, "coordination packet supportingFiles");
  if (decision === "noop") {
    if (memoryAction !== "noop") {
      throw new Error("coordination packet noop decision must use memoryAction=noop");
    }
    if (memoryTopics.length > 0) {
      throw new Error("coordination packet noop decision must not declare memoryTopics");
    }
    if (supportingFiles.length > 0) {
      throw new Error("coordination packet noop decision must not declare supportingFiles");
    }
  } else {
    if (memoryAction !== "compress-memory") {
      throw new Error("coordination packet create/update/merge decision must use memoryAction=compress-memory");
    }
    if (memoryTopics.length === 0) {
      throw new Error("coordination packet create/update/merge decision must declare memoryTopics");
    }
  }

  return {
    decision,
    targetSkill: targetSkill as string | null,
    mergedSkills,
    why: record.why,
    memoryAction,
    memoryTopics,
    supportingFiles,
  };
}

function validateChangeSet(value: unknown): LearnedSkillChangeSet {
  const record = assertRecord(value, "learned skill change set");
  assertExactKeys(record, ["changedSkills", "changedFiles"], "learned skill change set");
  return {
    changedSkills: assertStringArray(record.changedSkills, "learned skill change set changedSkills"),
    changedFiles: assertStringArray(record.changedFiles, "learned skill change set changedFiles"),
  };
}

export function validateSkillEvolutionChangeSet(
  coordination: SkillEvolutionCoordinationPacket,
  value: unknown,
): LearnedSkillChangeSet {
  const changeSet = validateChangeSet(value);
  if (coordination.decision === "noop") {
    if (changeSet.changedSkills.length > 0 || changeSet.changedFiles.length > 0) {
      throw new Error("noop decision changed learned skill files");
    }
    return changeSet;
  }

  if (coordination.decision === "merge") {
    const expected = new Set([coordination.targetSkill as string, ...coordination.mergedSkills]);
    const actual = new Set(changeSet.changedSkills);
    const sameSize = actual.size === expected.size;
    const sameItems = [...expected].every((skillName) => actual.has(skillName));
    if (!sameSize || !sameItems) {
      throw new Error("merge decision must change targetSkill and every mergedSkills entry");
    }
    const outsideMergeSet = changeSet.changedFiles.find((relativePath) => {
      const skillName = relativePath.split("/")[0] ?? "";
      return !expected.has(skillName);
    });
    if (outsideMergeSet) {
      throw new Error("merge decision changed files outside targetSkill or mergedSkills");
    }
    return changeSet;
  }

  if (changeSet.changedSkills.length !== 1 || changeSet.changedFiles.length === 0) {
    throw new Error("create/update decision must change exactly one learned skill");
  }
  if (changeSet.changedSkills[0] !== coordination.targetSkill) {
    throw new Error("changed learned skill must match coordination targetSkill");
  }
  const changedSkill = changeSet.changedSkills[0];
  const outsideTarget = changeSet.changedFiles.find(
    (relativePath) => relativePath !== changedSkill && !relativePath.startsWith(`${changedSkill}/`),
  );
  if (outsideTarget) {
    throw new Error("changed learned skill files must be inside coordination targetSkill");
  }
  return changeSet;
}

function toToolSpecs(tools: SkillEvolutionTool[]): CanonicalToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    strict: true,
    inputSchema: {
      type: "object",
      properties: tool.inputSchema.properties,
      required: tool.inputSchema.required ?? [],
      additionalProperties: false,
    },
  }));
}

function buildSkillEvolutionUserMessage(input: {
  reviewPacket: unknown;
  learnedSkillIndex: LearnedSkillsCatalog;
  toolTrajectory: unknown;
  artifactPaths: string[];
  qualitySignals: unknown;
}): string {
  return [
    "# Review packet",
    JSON.stringify(input.reviewPacket, null, 2),
    "",
    "# Learned skill index",
    JSON.stringify(input.learnedSkillIndex, null, 2),
    "",
    "# Tool trajectory",
    JSON.stringify(input.toolTrajectory, null, 2),
    "",
    "# Artifact paths",
    JSON.stringify(input.artifactPaths, null, 2),
    "",
    "# Quality signals",
    JSON.stringify(input.qualitySignals, null, 2),
    "",
    "Use read/write/edit/bash/glob/grep if a learned skill must change. After tool work is complete, return the final coordination packet as strict raw JSON.",
  ].join("\n");
}

async function runSkillToolLoop(input: {
  model: CanonicalModelCompletion;
  tools: SkillEvolutionTool[];
  systemPrompt: string;
  seedUserMessage: string;
  maxSteps?: number;
  signal?: AbortSignal;
}): Promise<{
  steps: number;
  toolCalls: string[];
  finalContent: string | null;
  stoppedReason: "no-tool-calls" | "max-steps" | "aborted";
}> {
  const maxSteps = clampSteps(typeof input.maxSteps === "number" ? input.maxSteps : DEFAULT_MAX_STEPS);
  const lookup = new Map(input.tools.map((tool) => [tool.name, tool]));
  const messages: CanonicalModelMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.seedUserMessage },
  ];
  const specs = toToolSpecs(input.tools);
  const toolCalls: string[] = [];
  let steps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal?.aborted) return { steps, toolCalls, finalContent: null, stoppedReason: "aborted" };

    const response = await input.model.complete({
      messages,
      tools: specs,
      signal: input.signal,
    });
    steps += 1;
    messages.push(response.message);

    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      return {
        steps,
        toolCalls,
        finalContent: typeof response.message.content === "string" ? response.message.content : null,
        stoppedReason: "no-tool-calls",
      };
    }

    for (const call of calls) {
      const tool = lookup.get(call.name);
      if (!tool) throw new Error(`unknown skill evolution tool: ${call.name}`);

      let result: SkillEvolutionToolResult;
      try {
        result = await tool.handler(call.input ?? {});
      } catch (error) {
        result = {
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        };
      }
      toolCalls.push(call.name);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: clipToolResult(result.ok ? result.text : `error: ${result.text}`),
      });
    }
  }

  return { steps, toolCalls, finalContent: null, stoppedReason: "max-steps" };
}

function parseFinalCoordinationPacket(content: string | null): SkillEvolutionCoordinationPacket {
  if (content === null || content.trim() === "") {
    throw new Error("skill evolution final response must be a raw JSON coordination packet");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch (error) {
    throw new Error("skill evolution final response must be valid JSON");
  }
  return validateSkillEvolutionCoordinationPacket(parsed);
}

export async function runSkillEvolutionAgent<TCheckpoint>(
  options: RunSkillEvolutionAgentOptions<TCheckpoint>,
): Promise<SkillEvolutionAgentResult> {
  const learnedSkillIndex = await options.store.getLearnedSkillsCatalog({
    includeContent: options.includeSkillContent,
  });
  const checkpoint = await options.store.createSkillCheckpoint();

  try {
    const tools = options.store.createFileTools(checkpoint);
    const loop = await runSkillToolLoop({
      model: options.model,
      tools,
      systemPrompt: options.systemPrompt ?? DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT,
      seedUserMessage: buildSkillEvolutionUserMessage({
        reviewPacket: options.reviewPacket,
        learnedSkillIndex,
        toolTrajectory: options.toolTrajectory,
        artifactPaths: options.artifactPaths,
        qualitySignals: options.qualitySignals,
      }),
      maxSteps: options.maxSteps,
      signal: options.signal,
    });
    const coordination = parseFinalCoordinationPacket(loop.finalContent);

    const changeSet = validateSkillEvolutionChangeSet(
      coordination,
      await options.store.finalizeLearnedSkillChanges({
        checkpoint,
        sessionId: options.sessionId,
        learningSummary: {
          coordination,
          reviewPacket: options.reviewPacket,
          toolTrajectory: options.toolTrajectory,
          artifactPaths: options.artifactPaths,
          qualitySignals: options.qualitySignals,
        },
      }),
    );

    return {
      ...changeSet,
      coordination,
      learnedSkillIndex,
      toolCalls: loop.toolCalls,
      stoppedReason: loop.stoppedReason,
      steps: loop.steps,
    };
  } catch (err) {
    await options.store.rollbackSkillCheckpoint(checkpoint);
    throw err;
  }
}
