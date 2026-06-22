/**
 * Learned-skill evolution runner.
 *
 * This mirrors extraction/dream at the SDK layer: the SDK owns the model loop and
 * the skill package owns file mutations through its tools. The runner wraps the
 * pass in a skill checkpoint, finalizes the staged file changes, derives skill
 * coordination from the resulting diff, then hard-validates that the coordination
 * and actual changed skills agree.
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

export const DEFAULT_SKILL_EVOLUTION_SYSTEM_PROMPT = `You are a learned-skill evolution agent. You improve durable, reusable executable methods by editing learned-skill files with ordinary file tools. You do NOT report decisions as JSON — the system derives exactly what you did from the files you change.

# Scope

Review the supplied packet, learned skill index, tool trajectory, artifact paths, and quality signals, then decide whether a reusable method should become a NEW learned skill, UPDATE an existing one, MERGE duplicates, or stay unchanged. Act by editing files; nothing else is required.

# How to act (just edit files)

- Use only the provided file tools: read, write, edit, bash, glob, grep.
- EVERY path is RELATIVE to your sandboxed working directory. Use relative paths like "memscribe-learned-<slug>/SKILL.md". NEVER use an absolute filesystem path (do not write to any path that starts with "/").
- To CREATE or UPDATE: call the WRITE tool with a relative path "<skill-dir>/SKILL.md" and the full file contents. Do NOT use bash to create or write skill files. Updating an existing skill edits that skill's existing directory; creating uses a new directory.
- To MERGE duplicates: write the consolidated SKILL.md into the surviving skill directory (write tool), then delete each redundant skill directory with bash using a RELATIVE path (e.g. "rm -rf <dup-dir>"). Read each source in full before consolidating.
- If there is NO durable reusable method, change no files and stop. That is a valid no-op — do not invent a skill.
- Change at most ONE surviving skill per pass (plus, for a merge, the directories you delete).

# Skill directory + SKILL.md rules

- Every skill directory must be named memscribe-learned-<slug> (lowercase slug). If the method's natural name is "release-runbook", use directory "memscribe-learned-release-runbook".
- "<skill-dir>/SKILL.md" must start with strict YAML frontmatter containing EXACTLY: name, display_name, description. The name value must equal the directory name (memscribe-learned-<slug>).
- SKILL.md must include the sections "## Use Cases", "## Procedure", and "## Guardrails". Procedure steps must be numbered "1.", "2.", ... contiguously, not bullets.
- Optional supporting files may live under references/, scripts/, templates/, or assets/. They never replace SKILL.md.
- Keep names generic; never leak host project names or secrets into a learned skill.

# Valid SKILL.md shape

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

When your file edits are complete, stop calling tools. You do not need to emit any JSON, summary, or skill coordination.`;

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

export interface SkillEvolutionCoordination {
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
  coordination: SkillEvolutionCoordination;
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
  coordination: SkillEvolutionCoordination;
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

export function validateSkillEvolutionCoordination(
  value: unknown,
): SkillEvolutionCoordination {
  const record = assertRecord(value, "skill coordination");
  assertExactKeys(
    record,
    ["decision", "targetSkill", "mergedSkills", "why", "memoryAction", "memoryTopics", "supportingFiles"],
    "skill coordination",
  );

  const decision = record.decision;
  if (decision !== "create" && decision !== "update" && decision !== "merge" && decision !== "noop") {
    throw new Error("skill coordination decision must be create, update, merge, or noop");
  }

  const targetSkill = record.targetSkill;
  if (decision === "noop") {
    if (targetSkill !== null) {
      throw new Error("skill coordination targetSkill must be null for noop");
    }
  } else if (typeof targetSkill !== "string" || targetSkill.trim() === "") {
    throw new Error("skill coordination targetSkill must be a non-empty string");
  }

  if (typeof record.why !== "string" || record.why.trim() === "") {
    throw new Error("skill coordination why must be a non-empty string");
  }

  const mergedSkills = assertStringArray(record.mergedSkills, "skill coordination mergedSkills");
  if (decision === "merge") {
    if (mergedSkills.length === 0) {
      throw new Error("skill coordination merge decision must declare mergedSkills");
    }
    if (mergedSkills.includes(targetSkill as string)) {
      throw new Error("skill coordination mergedSkills must not include targetSkill");
    }
  } else if (mergedSkills.length > 0) {
    throw new Error("skill coordination mergedSkills is only allowed for merge");
  }

  const memoryAction = record.memoryAction;
  if (memoryAction !== "compress-memory" && memoryAction !== "noop") {
    throw new Error("skill coordination memoryAction must be compress-memory or noop");
  }

  const memoryTopics = assertStringArray(record.memoryTopics, "skill coordination memoryTopics");
  const supportingFiles = assertStringArray(record.supportingFiles, "skill coordination supportingFiles");
  if (decision === "noop") {
    if (memoryAction !== "noop") {
      throw new Error("skill coordination noop decision must use memoryAction=noop");
    }
    if (memoryTopics.length > 0) {
      throw new Error("skill coordination noop decision must not declare memoryTopics");
    }
    if (supportingFiles.length > 0) {
      throw new Error("skill coordination noop decision must not declare supportingFiles");
    }
  } else {
    if (memoryAction !== "compress-memory") {
      throw new Error("skill coordination create/update/merge decision must use memoryAction=compress-memory");
    }
    if (memoryTopics.length === 0) {
      throw new Error("skill coordination create/update/merge decision must declare memoryTopics");
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
  coordination: SkillEvolutionCoordination,
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

/**
 * Project the catalog down to relative, model-safe fields. Critically this DROPS the
 * absolute `skillsRoot` path (and any other absolute paths): the model must only ever
 * see and write RELATIVE skill paths into the sandboxed staging tree — never the real
 * published root, which it could otherwise target directly via bash.
 */
function sanitizeSkillIndex(index: LearnedSkillsCatalog): unknown {
  const skills = Array.isArray(index?.skills) ? index.skills : [];
  return skills.map((skill) => {
    if (!skill || typeof skill !== "object") return skill;
    const entry = skill as Record<string, unknown>;
    return {
      name: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      relativePath: entry.relativePath,
      ...(typeof entry.skillContent === "string" ? { skillContent: entry.skillContent } : {}),
    };
  });
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
    JSON.stringify(sanitizeSkillIndex(input.learnedSkillIndex), null, 2),
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
    "Use read/write/edit/bash/glob/grep to make the skill file changes. The system derives what changed from the files — you do not need to emit any JSON. If no durable reusable method exists, change nothing.",
  ].join("\n");
}

/** The skill name == its directory name (memscribe-learned-<slug>). */
function skillDirOf(relativePath: string): string {
  return relativePath.split("/")[0] ?? "";
}

/** All skill directories present in the staged tree after the model's edits. */
async function listStagedSkillNames(tools: SkillEvolutionTool[]): Promise<Set<string>> {
  const glob = new Map(tools.map((tool) => [tool.name, tool])).get("glob");
  if (!glob) return new Set();
  const res = await glob.handler({ pattern: "*/SKILL.md" });
  if (!res.ok) return new Set();
  return new Set(
    res.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith("/SKILL.md"))
      .map(skillDirOf)
      .filter(Boolean),
  );
}

const NOOP_COORDINATION: SkillEvolutionCoordination = {
  decision: "noop",
  targetSkill: null,
  mergedSkills: [],
  why: "no durable reusable method was observed",
  memoryAction: "noop",
  memoryTopics: [],
  supportingFiles: [],
};

/** A human-readable topic derived from a skill directory name, for memory compression. */
function humanizeSkillSlug(skillName: string): string {
  const slug = skillName.replace(/^memscribe-learned-/, "").replace(/[-_]+/g, " ").trim();
  return slug || skillName;
}

/**
 * Derive the skill coordination from what the model ACTUALLY changed, classified
 * against the catalog that existed before the pass. Because the decision/targetSkill/
 * mergedSkills are inferred from the real change set, they always agree with it.
 */
function deriveCoordination(input: {
  changeSet: LearnedSkillChangeSet;
  catalogNames: Set<string>;
  deletedNames: string[];
}): SkillEvolutionCoordination {
  const { changeSet, catalogNames, deletedNames } = input;
  if (changeSet.changedSkills.length === 0) return NOOP_COORDINATION;

  const survivors = changeSet.changedSkills.filter((name) => !deletedNames.includes(name));
  let decision: SkillEvolutionDecision;
  let targetSkill: string;
  let mergedSkills: string[];
  if (deletedNames.length > 0 && survivors.length >= 1) {
    decision = "merge";
    targetSkill = survivors[0] as string;
    mergedSkills = [...deletedNames];
  } else {
    targetSkill = (survivors[0] ?? changeSet.changedSkills[0]) as string;
    decision = catalogNames.has(targetSkill) ? "update" : "create";
    mergedSkills = [];
  }

  // Close the loop back onto memory: a real skill change always triggers a follow-up
  // dream pass that compresses the now-redundant procedural detail in memory into a cue
  // pointing at the learned skill (the memory↔skill link).
  return {
    decision,
    targetSkill,
    mergedSkills,
    why: `${decision} ${targetSkill} from the observed reusable method`,
    memoryAction: "compress-memory",
    memoryTopics: [humanizeSkillSlug(targetSkill)],
    supportingFiles: [],
  };
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

export async function runSkillEvolutionAgent<TCheckpoint>(
  options: RunSkillEvolutionAgentOptions<TCheckpoint>,
): Promise<SkillEvolutionAgentResult> {
  const learnedSkillIndex = await options.store.getLearnedSkillsCatalog({
    includeContent: options.includeSkillContent,
  });
  const catalogNames = new Set(
    (learnedSkillIndex.skills ?? [])
      .map((skill) => (skill && typeof skill === "object" ? (skill as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === "string"),
  );
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

    // Derive what the model actually did from the staged file tree. A skill in the
    // catalog but no longer staged was deleted (authorizes a merge); otherwise it is a
    // create/update of the surviving skill. The model emits no JSON coordination.
    const stagedNames = await listStagedSkillNames(tools);
    const deletedNames = [...catalogNames].filter((name) => !stagedNames.has(name)).sort();

    const changeSet = await options.store.finalizeLearnedSkillChanges({
      checkpoint,
      sessionId: options.sessionId,
      learningSummary: {
        // finalize consults this only to authorize directory deletions for a merge.
        coordination:
          deletedNames.length > 0
            ? { ...NOOP_COORDINATION, decision: "merge", mergedSkills: deletedNames }
            : NOOP_COORDINATION,
        reviewPacket: options.reviewPacket,
        toolTrajectory: options.toolTrajectory,
        artifactPaths: options.artifactPaths,
        qualitySignals: options.qualitySignals,
      },
    });

    const coordination = deriveCoordination({ changeSet, catalogNames, deletedNames });
    validateSkillEvolutionCoordination(coordination);
    validateSkillEvolutionChangeSet(coordination, changeSet);

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
