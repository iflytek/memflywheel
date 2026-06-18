/**
 * SDK learning-loop orchestration.
 *
 * The host supplies concrete extraction, skill-evolution, and dream callbacks.
 * This module owns only the ordering and gates:
 *
 *   turn-end       -> extraction -> skill learning -> dream coordination
 *   error          -> extraction only
 *   inactive-flush -> skill review only
 */

import { type SkillEvolutionCoordinationPacket } from "./skill-evolution-agent.js";

export type LearningLoopTrigger = "turn-end" | "error" | "inactive-flush";
export type LearningLoopSource = "local" | "remote";

export interface SkillLearningGate {
  minDoneTurns: number;
  cooldownTurns: number;
  minToolCalls: number;
}

export const DEFAULT_SKILL_LEARNING_GATE: SkillLearningGate = {
  minDoneTurns: 3,
  cooldownTurns: 2,
  minToolCalls: 6,
};

export interface SkillLearningGateInput {
  source: LearningLoopSource;
  enabled: boolean;
  skillLearningEnabled: boolean;
  doneTurns: number;
  turnsSinceLastSkillEvolution: number;
  toolCalls: number;
  gate?: Partial<SkillLearningGate>;
}

export type SkillLearningGateReason =
  | "ok"
  | "non-local-source"
  | "disabled"
  | "skill-learning-disabled"
  | "min-done-turns"
  | "cooldown-turns"
  | "min-tool-calls"
  | "extraction-not-completed";

export interface SkillLearningGateResult {
  ok: boolean;
  reason: SkillLearningGateReason;
}

export function shouldRunSkillEvolution(input: SkillLearningGateInput): SkillLearningGateResult {
  const gate = { ...DEFAULT_SKILL_LEARNING_GATE, ...input.gate };
  if (input.source !== "local") return { ok: false, reason: "non-local-source" };
  if (!input.enabled) return { ok: false, reason: "disabled" };
  if (!input.skillLearningEnabled) return { ok: false, reason: "skill-learning-disabled" };
  if (input.doneTurns < gate.minDoneTurns) return { ok: false, reason: "min-done-turns" };
  if (input.turnsSinceLastSkillEvolution < gate.cooldownTurns) {
    return { ok: false, reason: "cooldown-turns" };
  }
  if (input.toolCalls < gate.minToolCalls) return { ok: false, reason: "min-tool-calls" };
  return { ok: true, reason: "ok" };
}

export interface DreamCoordinationFromSkill {
  reason: string;
  memoryAction: "compress-memory";
  topics: string[];
  targetSkill: string;
}

export interface SkillEvolutionLoopResult {
  coordination: SkillEvolutionCoordinationPacket;
  changedSkills: string[];
  changedFiles: string[];
}

export interface RunLearningLoopOptions extends SkillLearningGateInput {
  trigger: LearningLoopTrigger;
  extraction?: () => Promise<unknown>;
  skillEvolution?: () => Promise<SkillEvolutionLoopResult>;
  dream?: (coordination: DreamCoordinationFromSkill) => Promise<unknown>;
  skillEvolutionPrerequisite?: (input: {
    extraction: LearningLoopStepResult;
  }) => SkillLearningGateResult;
}

export interface LearningLoopStepResult<T = unknown> {
  ran: boolean;
  reason: string;
  value?: T;
}

export interface LearningLoopResult {
  extraction: LearningLoopStepResult;
  skillEvolution: LearningLoopStepResult<SkillEvolutionLoopResult>;
  dream: LearningLoopStepResult;
}

function skipped<T>(reason: string): LearningLoopStepResult<T> {
  return { ran: false, reason };
}

async function maybeRunExtraction(options: RunLearningLoopOptions): Promise<LearningLoopStepResult> {
  if (!options.enabled) return skipped("disabled");
  if (!options.extraction) return skipped("no-extraction-runner");
  return { ran: true, reason: "ok", value: await options.extraction() };
}

async function maybeRunSkillEvolution(
  options: RunLearningLoopOptions,
  extraction?: LearningLoopStepResult,
): Promise<LearningLoopStepResult<SkillEvolutionLoopResult>> {
  if (extraction && options.skillEvolutionPrerequisite) {
    const prerequisite = options.skillEvolutionPrerequisite({ extraction });
    if (!prerequisite.ok) return skipped(prerequisite.reason);
  }
  const gate = shouldRunSkillEvolution(options);
  if (!gate.ok) return skipped(gate.reason);
  if (!options.skillEvolution) return skipped("no-skill-evolution-runner");
  return { ran: true, reason: "ok", value: await options.skillEvolution() };
}

async function maybeRunDream(
  options: RunLearningLoopOptions,
  skillEvolution: LearningLoopStepResult<SkillEvolutionLoopResult>,
): Promise<LearningLoopStepResult> {
  if (!skillEvolution.ran || !skillEvolution.value) return skipped("no-skill-coordination");
  const packet = skillEvolution.value.coordination;
  if (packet.memoryAction === "noop") return skipped("memory-action-noop");
  if (!packet.targetSkill) throw new Error("compress-memory skill coordination requires targetSkill");
  if (!options.dream) return skipped("no-dream-runner");
  return {
    ran: true,
    reason: "ok",
    value: await options.dream({
      reason: packet.why,
      memoryAction: "compress-memory",
      topics: packet.memoryTopics,
      targetSkill: packet.targetSkill,
    }),
  };
}

export async function runLearningLoop(options: RunLearningLoopOptions): Promise<LearningLoopResult> {
  if (options.trigger === "error") {
    return {
      extraction: await maybeRunExtraction(options),
      skillEvolution: skipped("error-trigger"),
      dream: skipped("error-trigger"),
    };
  }

  if (options.trigger === "inactive-flush") {
    return {
      extraction: skipped("inactive-flush"),
      skillEvolution: await maybeRunSkillEvolution(options),
      dream: skipped("inactive-flush"),
    };
  }

  const extraction = await maybeRunExtraction(options);
  const skillEvolution = await maybeRunSkillEvolution(options, extraction);
  const dream = await maybeRunDream(options, skillEvolution);
  return { extraction, skillEvolution, dream };
}
