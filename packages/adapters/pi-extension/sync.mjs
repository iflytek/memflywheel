import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEARNED_SKILL_PREFIX = "memflywheel-learned-";

export function resolvePiAgentDir() {
  return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function resolveMemFlywheelRoot(piAgentDir) {
  return process.env.MEMFLYWHEEL_HOME || join(piAgentDir, "memflywheel");
}

export function syncLearnedSkillsToPi(input) {
  const sourceRoot = join(input.root, "learned-skills");
  const targetRoot = join(input.piAgentDir, "skills", "memflywheel");
  rmSync(targetRoot, { recursive: true, force: true });
  if (!existsSync(sourceRoot)) return;

  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(LEARNED_SKILL_PREFIX)) continue;
    const sourceDir = join(sourceRoot, entry.name);
    if (!existsSync(join(sourceDir, "SKILL.md"))) continue;
    cpSync(sourceDir, join(targetRoot, entry.name), { recursive: true });
  }
}
