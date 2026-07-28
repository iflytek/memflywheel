import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { syncLearnedSkillsToPi } from "./sync.mjs";

test("syncLearnedSkillsToPi mirrors learned skills into Pi native skills", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memflywheel-pi-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "memflywheel");
  const piAgentDir = join(dir, "pi-agent");
  const sourceDir = join(root, "learned-skills", "memflywheel-learned-release-review");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "SKILL.md"),
    [
      "---",
      "name: memflywheel-learned-release-review",
      "description: Review package release readiness.",
      "---",
      "",
      "Run release checks.",
      "",
    ].join("\n"),
  );
  mkdirSync(join(root, "learned-skills", "draft-skill"), { recursive: true });

  syncLearnedSkillsToPi({ root, piAgentDir });

  const target = join(
    piAgentDir,
    "skills",
    "memflywheel",
    "memflywheel-learned-release-review",
    "SKILL.md",
  );
  assert.match(readFileSync(target, "utf8"), /Review package release readiness/);
  assert.equal(existsSync(join(piAgentDir, "skills", "memflywheel", "draft-skill")), false);
});

test("syncLearnedSkillsToPi removes stale Pi skill mirrors", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memflywheel-pi-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "memflywheel");
  const piAgentDir = join(dir, "pi-agent");
  const stale = join(piAgentDir, "skills", "memflywheel", "memflywheel-learned-old", "SKILL.md");
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, "old");

  syncLearnedSkillsToPi({ root, piAgentDir });

  assert.equal(existsSync(stale), false);
});
