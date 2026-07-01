import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FinalizeSafetyError,
  LEARNED_SKILL_DIR_PREFIX,
  LearnedSkillValidationError,
  type LearnedSkillTool,
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
name: memflywheel-learned-editor-workflow
description: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.
---

## Overview

Editor workflow skills preserve reusable editing judgment, not one-off notes.

## When to Use

- Use when the user repeats the same editor workflow or shortcut sequence.
- Do not use for a one-time editing preference.

## Steps

1. Inspect the current workflow evidence.
2. Record the durable rule and its trigger.

## Common Mistakes

- Writing the whole successful transcript instead of the reusable trigger.
`;

function skillContent(skillName: string, description: string): string {
  return `---
name: ${skillName}
description: ${description}
---

## Overview

Editor workflow skills preserve reusable editing judgment, not one-off notes.

## When to Use

- Use when the user repeats the same editor workflow or shortcut sequence.
- Do not use for a one-time editing preference.

## Steps

1. Inspect the current workflow evidence.
2. Record the durable rule and its trigger.

## Common Mistakes

- Writing the whole successful transcript instead of the reusable trigger.
`;
}

function validFiles(): Record<string, string> {
  return {
    "SKILL.md": validSkill,
    "references/source.md": "Reference notes.\n",
    "templates/report.md": "# Report\n",
    "scripts/check.mjs": "export function check() { return true; }\n",
    "assets/schema.json": '{"type":"object"}\n',
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

function toolMap(tools: LearnedSkillTool[]): Map<string, LearnedSkillTool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("validateLearnedSkillPackage accepts the MemFlywheel learned skill layout", () => {
  const result = validateLearnedSkillPackage({ slug: "editor-workflow", files: validFiles() });

  assert.equal(result.skillDir, `${LEARNED_SKILL_DIR_PREFIX}editor-workflow`);
  assert.deepEqual(result.supportingFiles.sort(), [
    "assets/schema.json",
    "references/source.md",
    "scripts/check.mjs",
    "templates/report.md",
  ]);

  const skillWithType = validSkill.replace(
    "description: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.\n",
    "type: skill\ndescription: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.\n",
  );
  const withType = validateLearnedSkillPackage({
    slug: "editor-workflow",
    files: { ...validFiles(), "SKILL.md": skillWithType },
  });
  assert.equal(withType.skillName, `${LEARNED_SKILL_DIR_PREFIX}editor-workflow`);
});

test("validateLearnedSkillPackage accepts loose skill markdown", () => {
  const extraFrontmatterKey = validSkill.replace(
    "description: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.\n",
    "description: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.\nversion: 1\n",
  );
  assert.equal(
    validateLearnedSkillPackage({
      slug: "editor-workflow",
      files: { ...validFiles(), "SKILL.md": extraFrontmatterKey },
    }).skillName,
    `${LEARNED_SKILL_DIR_PREFIX}editor-workflow`,
  );

  const invalidType = validSkill.replace(
    "description: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.\n",
    "type: workflow\ndescription: Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.\n",
  );
  assert.equal(
    validateLearnedSkillPackage({
      slug: "editor-workflow",
      files: { ...validFiles(), "SKILL.md": invalidType },
    }).frontmatter.description,
    "Use when repeated editor workflow habits appear and need a reusable trigger-based skill instead of another memory note.",
  );

  const unnumberedProcedure = validSkill.replace(
    "1. Inspect the current workflow evidence.\n2. Record the durable rule and its trigger.",
    "- Inspect the current workflow evidence.\n- Record the durable rule and its trigger.",
  );
  assert.equal(
    validateLearnedSkillPackage({
      slug: "editor-workflow",
      files: { ...validFiles(), "SKILL.md": unnumberedProcedure },
    }).frontmatter.name,
    `${LEARNED_SKILL_DIR_PREFIX}editor-workflow`,
  );

  const noFrontmatter = "# Editor workflow\n\nUse this for editor workflow habits.\n";
  assert.deepEqual(
    validateLearnedSkillPackage({
      slug: "editor-workflow",
      files: { ...validFiles(), "SKILL.md": noFrontmatter },
    }).frontmatter,
    {
      name: `${LEARNED_SKILL_DIR_PREFIX}editor-workflow`,
      description: "Learned skill.",
    },
  );
});

test("validateLearnedSkillPackage rejects invalid supporting files and configured public naming residues", () => {
  assert.throws(
    () =>
      validateLearnedSkillPackage({
        slug: "editor-workflow",
        files: { ...validFiles(), "references/.env": "TOKEN=1\n" },
      }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError && error.message.includes("sensitive file name"),
  );

  assert.throws(
    () =>
      validateLearnedSkillPackage({
        slug: "editor-workflow",
        files: { ...validFiles(), "assets/empty.json": "" },
      }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError && error.message.includes("must be non-empty"),
  );

  assert.throws(
    () =>
      validateLearnedSkillPackage({
        slug: "editor-workflow",
        files: {
          ...validFiles(),
          "assets/large.bin": new Uint8Array(MAX_SUPPORTING_FILE_BYTES + 1),
        },
      }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("exceeds 1048576 bytes"),
  );

  const leakedName = validSkill.replace("editor workflow habits", "LegacyHost workflow habits");
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

  assert.throws(
    () =>
      validateLearnedSkillPackage({
        slug: "editor-workflow",
        files: { ...validFiles(), ".internal.json": "{}\n" },
      }),
    (error: unknown) =>
      error instanceof LearnedSkillValidationError &&
      error.message.includes("supporting files must live under"),
  );
});

test("checkpointLearnedSkill stages files outside the skills root and finalize writes only the learned skill directory", async () => {
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
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
      path.join(
        checkpointRoot,
        "cp-write",
        "staged",
        "memflywheel-learned-editor-workflow",
        "SKILL.md",
      ),
      "utf8",
    );
    assert.equal(stagedSkill, validSkill);

    const result = await finalizeLearnedSkillCheckpoint(checkpoint);
    assert.equal(result.skillDir, "memflywheel-learned-editor-workflow");
    assert.deepEqual(result.changedPaths.sort(), [
      "memflywheel-learned-editor-workflow/SKILL.md",
      "memflywheel-learned-editor-workflow/assets/schema.json",
      "memflywheel-learned-editor-workflow/references/source.md",
      "memflywheel-learned-editor-workflow/scripts/check.mjs",
      "memflywheel-learned-editor-workflow/templates/report.md",
    ]);
    assert.equal(await readFile(path.join(skillsRoot, "unrelated.md"), "utf8"), "original\n");
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("finalizeLearnedSkillCheckpoint refuses deletions and external changes after checkpoint", async () => {
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
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
        error instanceof FinalizeSafetyError && error.message.includes("refuses deleted paths"),
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
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
  try {
    await writeRaw(skillsRoot, "memflywheel-learned-editor-workflow/SKILL.md", validSkill);
    const checkpoint = await checkpointLearnedSkill({
      skillsRoot,
      checkpointRoot,
      checkpointId: "cp-target-race",
      slug: "editor-workflow",
      files: validFiles(),
    });

    await writeRaw(
      skillsRoot,
      "memflywheel-learned-editor-workflow/references/interloper.md",
      "changed after checkpoint\n",
    );
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
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
  try {
    await writeRaw(
      skillsRoot,
      "memflywheel-learned-editor-workflow/SKILL.md",
      validSkill.replace("reusable editing judgment", "original editor judgment"),
    );
    await writeRaw(skillsRoot, "memflywheel-learned-editor-workflow/assets/kept.txt", "keep me\n");

    const checkpoint = await checkpointLearnedSkill({
      skillsRoot,
      checkpointRoot,
      checkpointId: "cp-rollback",
      slug: "editor-workflow",
      files: validFiles(),
    });
    await finalizeLearnedSkillCheckpoint(checkpoint);
    await rollbackLearnedSkillCheckpoint(checkpoint);

    const restoredSkill = await readFile(
      path.join(skillsRoot, "memflywheel-learned-editor-workflow", "SKILL.md"),
      "utf8",
    );
    assert.match(restoredSkill, /original editor judgment/);
    assert.equal(
      await readFile(
        path.join(skillsRoot, "memflywheel-learned-editor-workflow", "assets", "kept.txt"),
        "utf8",
      ),
      "keep me\n",
    );
    await assert.rejects(
      readFile(
        path.join(skillsRoot, "memflywheel-learned-editor-workflow", "templates", "report.md"),
        "utf8",
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("createLearnedSkillStore commits staged tool writes and can rollback after finalize", async () => {
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
  try {
    const store = createLearnedSkillStore({ skillsRoot, checkpointRoot });
    const checkpoint = await store.createSkillCheckpoint();
    const tools = toolMap(store.createFileTools(checkpoint));
    const write = tools.get("write");
    assert.ok(write, "write tool exists");

    await write.handler({
      filePath: "memflywheel-learned-editor-workflow/SKILL.md",
      content: validSkill,
    });

    const result = await store.finalizeLearnedSkillChanges({
      checkpoint,
      sessionId: "session-1",
    });
    assert.deepEqual(result.changedSkills, ["memflywheel-learned-editor-workflow"]);
    assert.deepEqual(result.changedFiles.sort(), ["memflywheel-learned-editor-workflow/SKILL.md"]);
    const publishedSkill = await readFile(
      path.join(skillsRoot, "memflywheel-learned-editor-workflow", "SKILL.md"),
      "utf8",
    );
    assert.doesNotMatch(publishedSkill, /^type: skill$/m);

    const catalog = await store.getLearnedSkillsCatalog({ includeContent: true });
    assert.equal(catalog.learnedSkills.length, 1);
    assert.equal(catalog.learnedSkills[0]?.name, "memflywheel-learned-editor-workflow");
    assert.match(catalog.learnedSkills[0]?.skillContent ?? "", /## When to Use/);

    await store.rollbackSkillCheckpoint(checkpoint);
    const emptyCatalog = await store.getLearnedSkillsCatalog();
    assert.equal(emptyCatalog.learnedSkills.length, 0);
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("createLearnedSkillStore can merge by updating one skill and archiving a duplicate", async () => {
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
  const target = "memflywheel-learned-editor-workflow";
  const duplicate = "memflywheel-learned-editor-shortcuts";
  try {
    await writeRaw(
      skillsRoot,
      `${target}/SKILL.md`,
      skillContent(target, "Use when repeated editor workflow habits appear."),
    );
    await writeRaw(
      skillsRoot,
      `${duplicate}/SKILL.md`,
      skillContent(duplicate, "Use when duplicate editor workflow shortcuts appear."),
    );

    const store = createLearnedSkillStore({ skillsRoot, checkpointRoot });
    const checkpoint = await store.createSkillCheckpoint();
    const tools = toolMap(store.createFileTools(checkpoint));

    await tools.get("write")!.handler({
      filePath: `${target}/SKILL.md`,
      content: skillContent(target, "Use when editor workflow and shortcut procedures overlap."),
    });
    await tools.get("bash")!.handler({
      command: `rm -rf ${duplicate}`,
    });

    const result = await store.finalizeLearnedSkillChanges({
      checkpoint,
      sessionId: "session-1",
      learningSummary: {
        coordination: {
          decision: "merge",
          targetSkill: target,
          mergedSkills: [duplicate],
        },
      },
    });
    assert.deepEqual(result.changedSkills.sort(), [duplicate, target]);
    assert.deepEqual(result.changedFiles.sort(), [`${duplicate}/SKILL.md`, `${target}/SKILL.md`]);

    const catalog = await store.getLearnedSkillsCatalog({ includeContent: true });
    assert.deepEqual(
      catalog.learnedSkills.map((skill) => skill.name),
      [target],
    );
    assert.match(
      catalog.learnedSkills[0]?.skillContent ?? "",
      /Use when editor workflow and shortcut procedures overlap/,
    );

    await store.rollbackSkillCheckpoint(checkpoint);
    const restored = await store.getLearnedSkillsCatalog();
    assert.deepEqual(restored.learnedSkills.map((skill) => skill.name).sort(), [duplicate, target]);
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});

test("createLearnedSkillRecallProvider exposes learned skill routes for prompt build", async () => {
  const skillsRoot = await makeRoot("memflywheel-skills-root-");
  const checkpointRoot = await makeRoot("memflywheel-skill-checkpoints-");
  try {
    const store = createLearnedSkillStore({ skillsRoot, checkpointRoot });
    const checkpoint = await store.createSkillCheckpoint();
    const tools = toolMap(store.createFileTools(checkpoint));
    await tools.get("write")!.handler({
      filePath: "memflywheel-learned-editor-workflow/SKILL.md",
      content: validSkill,
    });
    await store.finalizeLearnedSkillChanges({ checkpoint, sessionId: "session-1" });

    const provider = createLearnedSkillRecallProvider({ skillsRoot });
    const packet = await provider({ sessionId: "session-1" });

    assert.equal(packet.entries.length, 1);
    assert.equal(packet.entries[0]?.name, "memflywheel-learned-editor-workflow");
    assert.deepEqual(packet.entries[0]?.triggerHints, ["editor workflow"]);
    assert.equal(
      packet.entries[0]?.relativePath,
      path.join(skillsRoot, "memflywheel-learned-editor-workflow", "SKILL.md"),
    );
    assert.match(
      buildLearnedSkillPrelude(packet),
      /memflywheel-learned-editor-workflow[\s\S]*editor workflow/,
    );
  } finally {
    await cleanup(skillsRoot);
    await cleanup(checkpointRoot);
  }
});
