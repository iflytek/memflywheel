import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FinalizeSafetyError,
  LEARNED_SKILL_DIR_PREFIX,
  LearnedSkillValidationError,
  MAX_SUPPORTING_FILE_BYTES,
  checkpointLearnedSkill,
  finalizeLearnedSkillCheckpoint,
  rollbackLearnedSkillCheckpoint,
  validateLearnedSkillPackage,
  createLearnedSkillStore,
  createLearnedSkillRecallProvider,
  buildLearnedSkillPrelude,
} from "./learned-skill.js";

const validSkill = `---
name: memscribe-learned-editor-workflow
display_name: Editor Workflow
description: Captures durable editor workflow habits.
---

## Use Cases

- Preserve repeatable editor workflow choices.

## Procedure

1. Inspect the current workflow evidence.
2. Record the durable rule and its trigger.

## Guardrails

- Keep host-specific details out of public skill text.
`;

function validFiles(): Record<string, string> {
  return {
    "SKILL.md": validSkill,
    ".memscribe-skill.json": `${JSON.stringify({ name: "memscribe-learned-editor-workflow" }, null, 2)}\n`,
    "references/source.md": "Reference notes.\n",
    "templates/report.md": "# Report\n",
    "scripts/check.mjs": "export function check() { return true; }\n",
    "assets/schema.json": "{\"type\":\"object\"}\n",
  };
}

async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

async function writeRaw(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("validateLearnedSkillPackage accepts the MemScribe learned skill layout", () => {
  const result = validateLearnedSkillPackage({ slug: "editor-workflow", files: validFiles() });

  assert.equal(result.skillDir, `${LEARNED_SKILL_DIR_PREFIX}editor-workflow`);
  assert.deepEqual(result.supportingFiles.sort(), [
    "assets/schema.json",
    "references/source.md",
    "scripts/check.mjs",
    "templates/report.md",
  ]);
});

test("validateLearnedSkillPackage rejects loose frontmatter and unnumbered procedures", () => {
  const extraFrontmatterKey = validSkill.replace(
    "description: Captures durable editor workflow habits.\n",
    "description: Captures durable editor workflow habits.\nversion: 1\n",
  );
  assert.throws(
    () => validateLearnedSkillPackage({ slug: "editor-workflow", files: { ...validFiles(), "SKILL.md": extraFrontmatterKey } }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("strict frontmatter keys"),
  );

  const unnumberedProcedure = validSkill.replace(
    "1. Inspect the current workflow evidence.\n2. Record the durable rule and its trigger.",
    "- Inspect the current workflow evidence.\n- Record the durable rule and its trigger.",
  );
  assert.throws(
    () => validateLearnedSkillPackage({ slug: "editor-workflow", files: { ...validFiles(), "SKILL.md": unnumberedProcedure } }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("Procedure must use numbered steps"),
  );
});

test("validateLearnedSkillPackage rejects invalid supporting files and configured public naming residues", () => {
  assert.throws(
    () => validateLearnedSkillPackage({ slug: "editor-workflow", files: { ...validFiles(), "references/.env": "TOKEN=1\n" } }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("sensitive file name"),
  );

  assert.throws(
    () => validateLearnedSkillPackage({ slug: "editor-workflow", files: { ...validFiles(), "assets/empty.json": "" } }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("must be non-empty"),
  );

  assert.throws(
    () =>
      validateLearnedSkillPackage({
        slug: "editor-workflow",
        files: { ...validFiles(), "assets/large.bin": new Uint8Array(MAX_SUPPORTING_FILE_BYTES + 1) },
      }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("exceeds 1048576 bytes"),
  );

  const leakedName = validSkill.replace("durable editor workflow", "LegacyHost editor workflow");
  assert.throws(
    () =>
      validateLearnedSkillPackage({
        slug: "editor-workflow",
        files: { ...validFiles(), "SKILL.md": leakedName },
        forbiddenPublicNames: ["LegacyHost"],
      }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("forbidden public name"),
  );
});

test("checkpointLearnedSkill stages files outside the skills root and finalize writes only the learned skill directory", async () => {
  const skillsRoot = await makeRoot("memscribe-skills-root-");
  const checkpointRoot = await makeRoot("memscribe-skill-checkpoints-");
  try {
    await writeRaw(skillsRoot, "unrelated.md", "original\n");
    const checkpoint = await checkpointLearnedSkill({
      skillsRoot,
      checkpointRoot,
      checkpointId: "cp-write",
      slug: "editor-workflow",
      files: validFiles(),
    });

    const stagedSkill = await readFile(
      path.join(checkpointRoot, "cp-write", "staged", "memscribe-learned-editor-workflow", "SKILL.md"),
      "utf8",
    );
    assert.equal(stagedSkill, validSkill);

    const result = await finalizeLearnedSkillCheckpoint(checkpoint);
    assert.equal(result.skillDir, "memscribe-learned-editor-workflow");
    assert.deepEqual(result.changedPaths.sort(), [
      "memscribe-learned-editor-workflow/.memscribe-skill.json",
      "memscribe-learned-editor-workflow/SKILL.md",
      "memscribe-learned-editor-workflow/assets/schema.json",
      "memscribe-learned-editor-workflow/references/source.md",
      "memscribe-learned-editor-workflow/scripts/check.mjs",
      "memscribe-learned-editor-workflow/templates/report.md",
    ]);
    assert.equal(await readFile(path.join(skillsRoot, "unrelated.md"), "utf8"), "original\n");
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("finalizeLearnedSkillCheckpoint refuses deletions and external changes after checkpoint", async () => {
  const skillsRoot = await makeRoot("memscribe-skills-root-");
  const checkpointRoot = await makeRoot("memscribe-skill-checkpoints-");
  try {
    await writeRaw(skillsRoot, "unrelated.md", "original\n");
    const checkpoint = await checkpointLearnedSkill({
      skillsRoot,
      checkpointRoot,
      checkpointId: "cp-safe",
      slug: "editor-workflow",
      files: validFiles(),
    });

    await rm(path.join(skillsRoot, "unrelated.md"));
    await assert.rejects(
      finalizeLearnedSkillCheckpoint(checkpoint),
      (error: unknown) =>
        error instanceof FinalizeSafetyError &&
        error.message.includes("refuses deleted paths"),
    );

    await writeRaw(skillsRoot, "unrelated.md", "modified\n");
    await writeRaw(skillsRoot, "outside.md", "new\n");
    await assert.rejects(
      finalizeLearnedSkillCheckpoint(checkpoint),
      (error: unknown) =>
        error instanceof FinalizeSafetyError &&
        error.message.includes("outside learned skill directory"),
    );
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("finalizeLearnedSkillCheckpoint refuses target changes after checkpoint", async () => {
  const skillsRoot = await makeRoot("memscribe-skills-root-");
  const checkpointRoot = await makeRoot("memscribe-skill-checkpoints-");
  try {
    await writeRaw(skillsRoot, "memscribe-learned-editor-workflow/SKILL.md", validSkill);
    const checkpoint = await checkpointLearnedSkill({
      skillsRoot,
      checkpointRoot,
      checkpointId: "cp-target-race",
      slug: "editor-workflow",
      files: validFiles(),
    });

    await writeRaw(skillsRoot, "memscribe-learned-editor-workflow/references/interloper.md", "changed after checkpoint\n");
    await assert.rejects(
      finalizeLearnedSkillCheckpoint(checkpoint),
      (error: unknown) =>
        error instanceof FinalizeSafetyError &&
        error.message.includes("target changed after checkpoint"),
    );
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("rollbackLearnedSkillCheckpoint restores a full target snapshot", async () => {
  const skillsRoot = await makeRoot("memscribe-skills-root-");
  const checkpointRoot = await makeRoot("memscribe-skill-checkpoints-");
  try {
    await writeRaw(skillsRoot, "memscribe-learned-editor-workflow/SKILL.md", validSkill.replace("durable editor", "original editor"));
    await writeRaw(skillsRoot, "memscribe-learned-editor-workflow/assets/kept.txt", "keep me\n");

    const checkpoint = await checkpointLearnedSkill({
      skillsRoot,
      checkpointRoot,
      checkpointId: "cp-rollback",
      slug: "editor-workflow",
      files: validFiles(),
    });
    await finalizeLearnedSkillCheckpoint(checkpoint);
    await rollbackLearnedSkillCheckpoint(checkpoint);

    const restoredSkill = await readFile(path.join(skillsRoot, "memscribe-learned-editor-workflow", "SKILL.md"), "utf8");
    assert.match(restoredSkill, /original editor/);
    assert.equal(await readFile(path.join(skillsRoot, "memscribe-learned-editor-workflow", "assets", "kept.txt"), "utf8"), "keep me\n");
    await assert.rejects(
      readFile(path.join(skillsRoot, "memscribe-learned-editor-workflow", "templates", "report.md"), "utf8"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("createLearnedSkillStore commits staged tool writes and can rollback after finalize", async () => {
  const skillsRoot = await makeRoot("memscribe-skills-root-");
  const checkpointRoot = await makeRoot("memscribe-skill-checkpoints-");
  try {
    const store = createLearnedSkillStore({ skillsRoot, checkpointRoot });
    const checkpoint = await store.createSkillCheckpoint();
    const tools = new Map(store.createSkillTools(checkpoint).map((tool) => [tool.name, tool]));
    const write = tools.get("skill_write");
    assert.ok(write, "skill_write tool exists");

    await write.handler({
      skillName: "memscribe-learned-editor-workflow",
      relativePath: "SKILL.md",
      content: validSkill,
    });
    await write.handler({
      skillName: "memscribe-learned-editor-workflow",
      relativePath: ".memscribe-skill.json",
      content: `${JSON.stringify({ name: "memscribe-learned-editor-workflow" }, null, 2)}\n`,
    });

    const result = await store.finalizeLearnedSkillChanges({
      checkpoint,
      sessionId: "session-1",
    });
    assert.deepEqual(result.changedSkills, ["memscribe-learned-editor-workflow"]);
    assert.deepEqual(result.changedFiles.sort(), [
      "memscribe-learned-editor-workflow/.memscribe-skill.json",
      "memscribe-learned-editor-workflow/SKILL.md",
    ]);

    const catalog = await store.getLearnedSkillsCatalog({ includeContent: true });
    assert.equal(catalog.learnedSkills.length, 1);
    assert.equal(catalog.learnedSkills[0]?.name, "memscribe-learned-editor-workflow");
    assert.match(catalog.learnedSkills[0]?.skillContent ?? "", /## Procedure/);

    await store.rollbackSkillCheckpoint(checkpoint);
    const emptyCatalog = await store.getLearnedSkillsCatalog();
    assert.equal(emptyCatalog.learnedSkills.length, 0);
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("createLearnedSkillRecallProvider exposes learned skill routes for prompt build", async () => {
  const skillsRoot = await makeRoot("memscribe-skills-root-");
  const checkpointRoot = await makeRoot("memscribe-skill-checkpoints-");
  try {
    const store = createLearnedSkillStore({ skillsRoot, checkpointRoot });
    const checkpoint = await store.createSkillCheckpoint();
    const tools = new Map(store.createSkillTools(checkpoint).map((tool) => [tool.name, tool]));
    await tools.get("skill_write")!.handler({
      skillName: "memscribe-learned-editor-workflow",
      relativePath: "SKILL.md",
      content: validSkill,
    });
    await store.finalizeLearnedSkillChanges({ checkpoint, sessionId: "session-1" });

    const provider = createLearnedSkillRecallProvider({ skillsRoot });
    const packet = await provider({
      sessionId: "session-1",
      usageRecords: [
        {
          skillName: "memscribe-learned-editor-workflow",
          outcome: "completed",
          trigger: "editor task",
        },
      ],
    });

    assert.equal(packet.entries.length, 1);
    assert.equal(packet.entries[0]?.name, "memscribe-learned-editor-workflow");
    assert.deepEqual(packet.entries[0]?.triggerHints, ["editor workflow", "durable editor workflow"]);
    assert.match(
      buildLearnedSkillPrelude(packet),
      /memscribe-learned-editor-workflow[\s\S]*completed/,
    );
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});
