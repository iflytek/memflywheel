import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SKILL_LEARNING_GATE,
  shouldRunSkillEvolution,
  runLearningLoop,
} from "./learning-loop.js";

test("shouldRunSkillEvolution: default gate requires local source, enabled flags, turns, cooldown, and tool calls", () => {
  assert.deepEqual(DEFAULT_SKILL_LEARNING_GATE, {
    minDoneTurns: 3,
    cooldownTurns: 2,
    minToolCalls: 6,
  });
  assert.equal(
    shouldRunSkillEvolution({
      source: "local",
      enabled: true,
      skillLearningEnabled: true,
      doneTurns: 3,
      turnsSinceLastSkillEvolution: 2,
      toolCalls: 6,
    }).ok,
    true,
  );
  assert.equal(
    shouldRunSkillEvolution({
      source: "remote",
      enabled: true,
      skillLearningEnabled: true,
      doneTurns: 10,
      turnsSinceLastSkillEvolution: 10,
      toolCalls: 10,
    }).ok,
    false,
  );
});

test("runLearningLoop: normal turn runs extraction, then skill evolution, then dream coordination", async () => {
  const events: string[] = [];
  const result = await runLearningLoop({
    trigger: "turn-end",
    source: "local",
    enabled: true,
    skillLearningEnabled: true,
    doneTurns: 3,
    turnsSinceLastSkillEvolution: 2,
    toolCalls: 6,
    extraction: async () => {
      events.push("extraction");
      return { result: "completed" };
    },
    skillEvolution: async () => {
      events.push("skill_learning");
      return {
        coordination: {
          decision: "update",
          targetSkill: "review-skill",
          mergedSkills: [],
          why: "The reusable review process should move from memory into a learned skill.",
          memoryAction: "compress-memory",
          memoryTopics: ["code review workflow"],
          supportingFiles: ["review-skill/SKILL.md"],
        },
        changedSkills: ["review-skill"],
        changedFiles: ["review-skill/SKILL.md"],
      };
    },
    dream: async (coordination) => {
      events.push(
        `dream:${coordination.memoryAction}:${coordination.topics.join(",")}:${coordination.targetSkill}`,
      );
      return { ran: true, reason: "ok" };
    },
  });

  assert.deepEqual(events, [
    "extraction",
    "skill_learning",
    "dream:compress-memory:code review workflow:review-skill",
  ]);
  assert.equal(result.extraction?.ran, true);
  assert.equal(result.skillEvolution?.ran, true);
  assert.equal(result.dream?.ran, true);
});

test("runLearningLoop: turn-end still runs skill evolution when extraction writes nothing", async () => {
  const events: string[] = [];
  const result = await runLearningLoop({
    trigger: "turn-end",
    source: "local",
    enabled: true,
    skillLearningEnabled: true,
    doneTurns: 3,
    turnsSinceLastSkillEvolution: 2,
    toolCalls: 6,
    extraction: async () => {
      events.push("extraction");
      return { result: "skipped" };
    },
    skillEvolution: async () => {
      events.push("skill_learning");
      return {
        coordination: {
          decision: "noop",
          targetSkill: null,
          mergedSkills: [],
          why: "no new reusable method",
          memoryAction: "noop",
          memoryTopics: [],
          supportingFiles: [],
        },
        changedSkills: [],
        changedFiles: [],
      };
    },
    dream: async () => {
      events.push("dream");
      return {};
    },
  });

  assert.deepEqual(events, ["extraction", "skill_learning"]);
  assert.equal(result.skillEvolution.ran, true);
  assert.equal(result.dream.ran, false);
});

test("runLearningLoop: error trigger only runs extraction", async () => {
  const events: string[] = [];
  const result = await runLearningLoop({
    trigger: "error",
    source: "local",
    enabled: true,
    skillLearningEnabled: true,
    doneTurns: 99,
    turnsSinceLastSkillEvolution: 99,
    toolCalls: 99,
    extraction: async () => {
      events.push("extraction");
      return { result: "failed-turn-captured" };
    },
    skillEvolution: async () => {
      events.push("skill_learning");
      return {
        coordination: {
          decision: "noop",
          targetSkill: null,
          mergedSkills: [],
          why: "not used",
          memoryAction: "noop",
          memoryTopics: [],
          supportingFiles: [],
        },
        changedSkills: [],
        changedFiles: [],
      };
    },
    dream: async () => {
      events.push("dream");
      return { ran: true };
    },
  });

  assert.deepEqual(events, ["extraction"]);
  assert.equal(result.skillEvolution?.ran, false);
  assert.equal(result.dream?.ran, false);
});

test("runLearningLoop: inactive flush only runs skill review, never extraction or dream", async () => {
  const events: string[] = [];
  const result = await runLearningLoop({
    trigger: "inactive-flush",
    source: "local",
    enabled: true,
    skillLearningEnabled: true,
    doneTurns: 3,
    turnsSinceLastSkillEvolution: 2,
    toolCalls: 6,
    extraction: async () => {
      events.push("extraction");
      return {};
    },
    skillEvolution: async () => {
      events.push("skill_learning");
      return {
        coordination: {
          decision: "noop",
          targetSkill: null,
          mergedSkills: [],
          why: "No skill update needed.",
          memoryAction: "noop",
          memoryTopics: [],
          supportingFiles: [],
        },
        changedSkills: [],
        changedFiles: [],
      };
    },
    dream: async () => {
      events.push("dream");
      return {};
    },
  });

  assert.deepEqual(events, ["skill_learning"]);
  assert.equal(result.extraction?.ran, false);
  assert.equal(result.skillEvolution?.ran, true);
  assert.equal(result.dream?.ran, false);
});
