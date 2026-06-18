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
import {
  type JsonSchemaObject,
  type ToolCall,
  type ToolCompletion,
  type ToolMessage,
  type ToolSpec,
} from "./tool-completion.js";

const DEFAULT_MAX_STEPS = 12;
const MAX_TOOL_RESULT_CHARS = 4000;

export const SKILL_LEARN_DECISION_TOOL = "skill_learn_decide";

export const DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT = `You are a learned-skill evolution agent. Your job is to improve durable executable methods by editing learned skills through the provided skill tools, then emit exactly one coordination packet through skill_learn_decide.

# Scope

Review the supplied packet, learned skill index, observed skill usages, tool trajectory, artifact paths, and quality signals. Decide whether a reusable method should become a learned skill, update an existing learned skill, or stay as no change.

# Rules

- Use skill tools for learned-skill file changes.
- decision=create or decision=update must change exactly one learned skill: the targetSkill named in the coordination packet.
- decision=noop must not change any learned skill files.
- Do not write memory files. If memory should be compressed after a skill update, set memoryAction=compress-memory and list the memoryTopics.
- Keep public names generic; do not leak host project names into learned skills unless they are part of the user's actual requested skill.
- If there is no durable reusable method, call skill_learn_decide with decision=noop and make no file changes.

# Required final coordination packet

Call skill_learn_decide exactly once with:
- decision: create | update | noop
- targetSkill: string for create/update, null for noop
- why: concise reason
- memoryAction: compress-memory | noop
- memoryTopics: string[]
- supportingFiles: string[]`;

export type SkillEvolutionDecision = "create" | "update" | "noop";
export type SkillEvolutionMemoryAction = "compress-memory" | "noop";

export interface SkillEvolutionCoordinationPacket {
  decision: SkillEvolutionDecision;
  targetSkill: string | null;
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
  observedSkillUsages: unknown;
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
  createSkillTools(checkpoint: TCheckpoint): SkillEvolutionTool[];
}

export interface RunSkillEvolutionAgentOptions<TCheckpoint = unknown> {
  toolCompletion: ToolCompletion;
  store: SkillEvolutionStore<TCheckpoint>;
  sessionId: string;
  reviewPacket: unknown;
  observedSkillUsages: unknown;
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
    ["decision", "targetSkill", "why", "memoryAction", "memoryTopics", "supportingFiles"],
    "coordination packet",
  );

  const decision = record.decision;
  if (decision !== "create" && decision !== "update" && decision !== "noop") {
    throw new Error("coordination packet decision must be create, update, or noop");
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
      throw new Error("coordination packet create/update decision must use memoryAction=compress-memory");
    }
    if (memoryTopics.length === 0) {
      throw new Error("coordination packet create/update decision must declare memoryTopics");
    }
  }

  return {
    decision,
    targetSkill: targetSkill as string | null,
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

function toToolSpecs(tools: SkillEvolutionTool[]): ToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      strict: true,
      parameters: {
        type: "object",
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required ?? [],
        additionalProperties: false,
      },
    },
  }));
}

function parseToolArguments(call: ToolCall): unknown {
  if (!call.function.arguments) return {};
  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch {
    throw new Error(`invalid JSON arguments for skill tool ${call.function.name}`);
  }
}

function buildSkillEvolutionUserMessage(input: {
  reviewPacket: unknown;
  learnedSkillIndex: LearnedSkillsCatalog;
  observedSkillUsages: unknown;
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
    "# Observed skill usages",
    JSON.stringify(input.observedSkillUsages, null, 2),
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
    "Use skill tools if a learned skill must change, then call skill_learn_decide exactly once.",
  ].join("\n");
}

const DECISION_TOOL_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["create", "update", "noop"],
      description: "create or update when exactly one learned skill changed; noop when no skill changed.",
    },
    targetSkill: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "For create/update, the exact learned skill directory name as a quoted JSON string. For noop, null.",
    },
    why: { type: "string", description: "Concise reason for the decision." },
    memoryAction: {
      type: "string",
      enum: ["compress-memory", "noop"],
      description: "compress-memory for create/update; noop for noop.",
    },
    memoryTopics: {
      type: "array",
      items: { type: "string" },
      description: "Memory topics to compress after create/update; empty for noop.",
    },
    supportingFiles: {
      type: "array",
      items: { type: "string" },
      description: "Relative learned-skill files that support the decision; empty for noop.",
    },
  },
  required: ["decision", "targetSkill", "why", "memoryAction", "memoryTopics", "supportingFiles"],
  additionalProperties: false,
};

async function runSkillToolLoop(input: {
  toolCompletion: ToolCompletion;
  tools: SkillEvolutionTool[];
  systemPrompt: string;
  seedUserMessage: string;
  maxSteps?: number;
  signal?: AbortSignal;
}): Promise<{
  steps: number;
  toolCalls: string[];
  stoppedReason: "no-tool-calls" | "max-steps" | "aborted";
}> {
  const maxSteps = clampSteps(typeof input.maxSteps === "number" ? input.maxSteps : DEFAULT_MAX_STEPS);
  const lookup = new Map(input.tools.map((tool) => [tool.name, tool]));
  const messages: ToolMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.seedUserMessage },
  ];
  const specs = toToolSpecs(input.tools);
  const toolCalls: string[] = [];
  let steps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal?.aborted) return { steps, toolCalls, stoppedReason: "aborted" };

    const response = await input.toolCompletion({
      messages,
      tools: specs,
      signal: input.signal,
    });
    steps += 1;
    messages.push(response.message);

    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) return { steps, toolCalls, stoppedReason: "no-tool-calls" };

    for (const call of calls) {
      const tool = lookup.get(call.function.name);
      if (!tool) throw new Error(`unknown skill evolution tool: ${call.function.name}`);

      const result = await tool.handler(parseToolArguments(call));
      toolCalls.push(call.function.name);
      if (!result.ok) throw new Error(`skill evolution tool failed: ${call.function.name}: ${result.text}`);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clipToolResult(result.text),
      });
    }
  }

  return { steps, toolCalls, stoppedReason: "max-steps" };
}

export async function runSkillEvolutionAgent<TCheckpoint>(
  options: RunSkillEvolutionAgentOptions<TCheckpoint>,
): Promise<SkillEvolutionAgentResult> {
  const learnedSkillIndex = await options.store.getLearnedSkillsCatalog({
    includeContent: options.includeSkillContent,
  });
  const checkpoint = await options.store.createSkillCheckpoint();

  let coordination: SkillEvolutionCoordinationPacket | null = null;
  const decisionTool: SkillEvolutionTool = {
    name: SKILL_LEARN_DECISION_TOOL,
    description: "Emit the required learned-skill coordination packet exactly once.",
    inputSchema: DECISION_TOOL_SCHEMA,
    handler: async (args) => {
      if (coordination) throw new Error("skill_learn_decide called more than once");
      coordination = validateSkillEvolutionCoordinationPacket(args);
      return { ok: true, text: "coordination packet accepted" };
    },
  };

  try {
    const tools = [...options.store.createSkillTools(checkpoint), decisionTool];
    const loop = await runSkillToolLoop({
      toolCompletion: options.toolCompletion,
      tools,
      systemPrompt: options.systemPrompt ?? DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT,
      seedUserMessage: buildSkillEvolutionUserMessage({
        reviewPacket: options.reviewPacket,
        learnedSkillIndex,
        observedSkillUsages: options.observedSkillUsages,
        toolTrajectory: options.toolTrajectory,
        artifactPaths: options.artifactPaths,
        qualitySignals: options.qualitySignals,
      }),
      maxSteps: options.maxSteps,
      signal: options.signal,
    });

    if (!coordination) {
      throw new Error("skill_learn_decide was not called");
    }

    const changeSet = validateSkillEvolutionChangeSet(
      coordination,
      await options.store.finalizeLearnedSkillChanges({
        checkpoint,
        sessionId: options.sessionId,
        learningSummary: {
          coordination,
          reviewPacket: options.reviewPacket,
          observedSkillUsages: options.observedSkillUsages,
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
