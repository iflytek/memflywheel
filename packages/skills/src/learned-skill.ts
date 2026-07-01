import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createFileTools as createCoreFileTools,
  type FileTool,
  type FileToolResult,
} from "@memflywheel/core";

export const LEARNED_SKILL_DIR_PREFIX = "memflywheel-learned-";
export const MAX_SUPPORTING_FILE_BYTES = 1024 * 1024;
export const SUPPORTING_DIRS = ["references", "templates", "scripts", "assets"] as const;

const CHECKPOINT_MANIFEST = "checkpoint.json";
const STORE_CHECKPOINT_MANIFEST = "store-checkpoint.json";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECKPOINT_ID_RE = /^[A-Za-z0-9._-]+$/;

const SENSITIVE_FILE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "kubeconfig",
]);

const SENSITIVE_FILE_NAME_PATTERNS = [
  /(^|[._-])secret(s)?([._-]|$)/i,
  /(^|[._-])token(s)?([._-]|$)/i,
  /(^|[._-])password(s)?([._-]|$)/i,
  /(^|[._-])credential(s)?([._-]|$)/i,
  /(^|[._-])private[_-]?key([._-]|$)/i,
] as const;

export class LearnedSkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearnedSkillValidationError";
  }
}

export class FinalizeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalizeSafetyError";
  }
}

export type LearnedSkillFileContent = string | Uint8Array;

export interface ValidateLearnedSkillPackageInput {
  slug: string;
  files: Record<string, LearnedSkillFileContent>;
  forbiddenPublicNames?: readonly string[];
}

export interface LearnedSkillFrontmatter {
  name: string;
  description: string;
}

export interface NormalizedLearnedSkillFile {
  relativePath: string;
  bytes: Uint8Array;
  text?: string;
}

export interface ValidatedLearnedSkillPackage {
  slug: string;
  skillName: string;
  skillDir: string;
  frontmatter: LearnedSkillFrontmatter;
  supportingFiles: string[];
  files: NormalizedLearnedSkillFile[];
}

export interface CheckpointLearnedSkillInput extends ValidateLearnedSkillPackageInput {
  skillsRoot: string;
  checkpointRoot: string;
  checkpointId?: string;
}

export interface LearnedSkillCheckpoint {
  checkpointId: string;
  checkpointDir: string;
  manifestPath: string;
  skillsRoot: string;
  checkpointRoot: string;
  skillDir: string;
}

export interface FinalizeLearnedSkillResult {
  skillDir: string;
  changedPaths: string[];
}

export interface RollbackLearnedSkillResult {
  skillDir: string;
  restored: boolean;
}

export interface LearnedSkillSupportingFile {
  path: string;
  kind: (typeof SUPPORTING_DIRS)[number];
  sizeBytes: number;
}

export interface LearnedSkillCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  relativePath: string;
  supportingFiles: LearnedSkillSupportingFile[];
  skillContent?: string;
}

export interface LearnedSkillsCatalog {
  skillsRoot: string;
  learnedSkills: LearnedSkillCatalogEntry[];
  skills: LearnedSkillCatalogEntry[];
}

export interface LearnedSkillRecallEntry {
  name: string;
  displayName: string;
  description: string;
  relativePath: string;
  triggerHints: string[];
}

export interface LearnedSkillRecallPacket {
  entries: LearnedSkillRecallEntry[];
}

export type LearnedSkillRecallProvider = (input: {
  sessionId?: string;
}) => Promise<LearnedSkillRecallPacket>;

export type LearnedSkillToolResult = FileToolResult;

export interface LearnedSkillTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: unknown) => Promise<LearnedSkillToolResult>;
}

export interface LearnedSkillChange {
  name: string;
  changedFiles: string[];
  supportingFiles: LearnedSkillSupportingFile[];
}

export interface LearnedSkillChangeSet {
  changedSkills: LearnedSkillChange[];
  changedFiles: string[];
}

export interface LearnedSkillStoreCheckpoint {
  checkpointId: string;
  checkpointDir: string;
  manifestPath: string;
}

export interface CreateLearnedSkillStoreOptions {
  skillsRoot: string;
  checkpointRoot?: string;
  forbiddenPublicNames?: readonly string[];
}

export interface LearnedSkillStore {
  getLearnedSkillsCatalog(input?: { includeContent?: boolean }): Promise<LearnedSkillsCatalog>;
  createSkillCheckpoint(): Promise<LearnedSkillStoreCheckpoint>;
  createFileTools(checkpoint: LearnedSkillStoreCheckpoint): LearnedSkillTool[];
  finalizeLearnedSkillChanges(input: {
    checkpoint: LearnedSkillStoreCheckpoint;
    sessionId: string;
    learningSummary?: unknown;
  }): Promise<{ changedSkills: string[]; changedFiles: string[] }>;
  rollbackSkillCheckpoint(checkpoint: LearnedSkillStoreCheckpoint): Promise<void>;
}

interface FileFingerprint {
  relativePath: string;
  size: number;
  sha256: string;
}

interface CheckpointManifest {
  version: 1;
  checkpointId: string;
  skillDir: string;
  skillsRoot: string;
  checkpointRoot: string;
  stagedSkillDir: string;
  snapshotTargetDir: string;
  targetExisted: boolean;
  beforeFiles: FileFingerprint[];
  plannedPaths: string[];
}

interface StoreCheckpointManifest {
  version: 1;
  kind: "learned-skill-store";
  checkpointId: string;
  skillsRoot: string;
  checkpointRoot: string;
  stageRoot: string;
  snapshotRoot: string;
  rootExisted: boolean;
  beforeFiles: FileFingerprint[];
}

export function validateLearnedSkillPackage(
  input: ValidateLearnedSkillPackageInput,
): ValidatedLearnedSkillPackage {
  const slug = validateSlug(input.slug);
  const skillName = `${LEARNED_SKILL_DIR_PREFIX}${slug}`;
  const normalizedFiles = normalizeFiles(input.files, input.forbiddenPublicNames ?? []);
  const skillFile = normalizedFiles.find((file) => file.relativePath === "SKILL.md");
  if (!skillFile?.text) {
    throw new LearnedSkillValidationError("learned skill package must include text SKILL.md");
  }

  const frontmatter = parseSkillFrontmatter(skillFile.text, skillName);

  return {
    slug,
    skillName,
    skillDir: skillName,
    frontmatter,
    supportingFiles: normalizedFiles
      .filter((file) => SUPPORTING_DIRS.some((dir) => file.relativePath.startsWith(`${dir}/`)))
      .map((file) => file.relativePath)
      .sort(),
    files: normalizedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

export async function checkpointLearnedSkill(
  input: CheckpointLearnedSkillInput,
): Promise<LearnedSkillCheckpoint> {
  const validated = validateLearnedSkillPackage(input);
  const skillsRoot = path.resolve(input.skillsRoot);
  const checkpointRoot = path.resolve(input.checkpointRoot);
  assertSeparateRoots(skillsRoot, checkpointRoot);

  const checkpointId = input.checkpointId ?? randomUUID();
  if (!CHECKPOINT_ID_RE.test(checkpointId)) {
    throw new LearnedSkillValidationError(
      "checkpointId must contain only letters, digits, dot, underscore, or dash",
    );
  }

  const checkpointDir = path.join(checkpointRoot, checkpointId);
  const manifestPath = path.join(checkpointDir, CHECKPOINT_MANIFEST);
  const stagedSkillDir = path.join(checkpointDir, "staged", validated.skillDir);
  const snapshotTargetDir = path.join(checkpointDir, "snapshot", validated.skillDir);
  const targetDir = path.join(skillsRoot, validated.skillDir);

  if (await pathExists(checkpointDir)) {
    throw new LearnedSkillValidationError(`checkpoint already exists: ${checkpointId}`);
  }

  await mkdir(skillsRoot, { recursive: true });
  await mkdir(stagedSkillDir, { recursive: true });

  const beforeFiles = await listFileFingerprints(skillsRoot);
  const targetExisted = await pathExists(targetDir);
  if (targetExisted) {
    await copyTree(targetDir, snapshotTargetDir);
  }

  for (const file of validated.files) {
    const filePath = path.join(stagedSkillDir, file.relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.bytes);
  }

  const manifest: CheckpointManifest = {
    version: 1,
    checkpointId,
    skillDir: validated.skillDir,
    skillsRoot,
    checkpointRoot,
    stagedSkillDir,
    snapshotTargetDir,
    targetExisted,
    beforeFiles,
    plannedPaths: validated.files.map((file) => `${validated.skillDir}/${file.relativePath}`),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    checkpointId,
    checkpointDir,
    manifestPath,
    skillsRoot,
    checkpointRoot,
    skillDir: validated.skillDir,
  };
}

export async function readLearnedSkillCheckpoint(
  checkpointDir: string,
): Promise<LearnedSkillCheckpoint> {
  const manifestPath = path.join(path.resolve(checkpointDir), CHECKPOINT_MANIFEST);
  const manifest = await readCheckpointManifest(manifestPath);
  return {
    checkpointId: manifest.checkpointId,
    checkpointDir: path.resolve(checkpointDir),
    manifestPath,
    skillsRoot: manifest.skillsRoot,
    checkpointRoot: manifest.checkpointRoot,
    skillDir: manifest.skillDir,
  };
}

export async function finalizeLearnedSkillCheckpoint(
  checkpoint: LearnedSkillCheckpoint,
): Promise<FinalizeLearnedSkillResult> {
  const manifest = await readCheckpointManifest(checkpoint.manifestPath);
  const currentBeforeFinalize = await listFileFingerprints(manifest.skillsRoot);
  const preExistingDiff = diffFingerprints(manifest.beforeFiles, currentBeforeFinalize);
  if (preExistingDiff.deletedPaths.length > 0) {
    throw new FinalizeSafetyError(
      `finalize refuses deleted paths: ${preExistingDiff.deletedPaths.join(", ")}`,
    );
  }
  const targetPreExistingChanges = preExistingDiff.changedPaths.filter((relativePath) =>
    isInSkillDir(relativePath, manifest.skillDir),
  );
  if (targetPreExistingChanges.length > 0) {
    throw new FinalizeSafetyError(
      `finalize refuses target changed after checkpoint: ${targetPreExistingChanges.join(", ")}`,
    );
  }
  const externalPreExistingChanges = preExistingDiff.changedPaths.filter(
    (relativePath) => !isInSkillDir(relativePath, manifest.skillDir),
  );
  if (externalPreExistingChanges.length > 0) {
    throw new FinalizeSafetyError(
      `finalize refuses changes outside learned skill directory: ${externalPreExistingChanges.join(", ")}`,
    );
  }

  const targetDir = path.join(manifest.skillsRoot, manifest.skillDir);
  await copyTree(manifest.stagedSkillDir, targetDir);

  const currentAfterFinalize = await listFileFingerprints(manifest.skillsRoot);
  const finalDiff = diffFingerprints(manifest.beforeFiles, currentAfterFinalize);
  if (finalDiff.deletedPaths.length > 0) {
    throw new FinalizeSafetyError(
      `finalize refuses deleted paths: ${finalDiff.deletedPaths.join(", ")}`,
    );
  }
  const externalFinalChanges = finalDiff.changedPaths.filter(
    (relativePath) => !isInSkillDir(relativePath, manifest.skillDir),
  );
  if (externalFinalChanges.length > 0) {
    throw new FinalizeSafetyError(
      `finalize refuses changes outside learned skill directory: ${externalFinalChanges.join(", ")}`,
    );
  }

  return {
    skillDir: manifest.skillDir,
    changedPaths: finalDiff.changedPaths.sort(),
  };
}

export async function rollbackLearnedSkillCheckpoint(
  checkpoint: LearnedSkillCheckpoint,
): Promise<RollbackLearnedSkillResult> {
  const manifest = await readCheckpointManifest(checkpoint.manifestPath);
  const targetDir = path.join(manifest.skillsRoot, manifest.skillDir);
  await rm(targetDir, { recursive: true, force: true });
  if (manifest.targetExisted) {
    await copyTree(manifest.snapshotTargetDir, targetDir);
  }
  return { skillDir: manifest.skillDir, restored: manifest.targetExisted };
}

export async function validateLearnedSkillDirectory(
  skillDir: string,
  forbiddenPublicNames: readonly string[] = [],
): Promise<ValidatedLearnedSkillPackage> {
  const resolved = path.resolve(skillDir);
  const dirName = path.basename(resolved);
  if (!dirName.startsWith(LEARNED_SKILL_DIR_PREFIX)) {
    throw new LearnedSkillValidationError(
      `learned skill directory must start with ${LEARNED_SKILL_DIR_PREFIX}`,
    );
  }
  const slug = dirName.slice(LEARNED_SKILL_DIR_PREFIX.length);
  const files = await readSkillDirectoryFiles(resolved);
  return validateLearnedSkillPackage({ slug, files, forbiddenPublicNames });
}

export async function getLearnedSkillsCatalog(input: {
  skillsRoot: string;
  includeContent?: boolean;
  forbiddenPublicNames?: readonly string[];
}): Promise<LearnedSkillsCatalog> {
  const skillsRoot = path.resolve(input.skillsRoot);
  const learnedSkills: LearnedSkillCatalogEntry[] = [];
  if (!(await pathExists(skillsRoot))) {
    return { skillsRoot, learnedSkills, skills: learnedSkills };
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith(LEARNED_SKILL_DIR_PREFIX)) {
      continue;
    }
    const skillDir = path.join(skillsRoot, entry.name);
    const validated = await validateLearnedSkillDirectory(
      skillDir,
      input.forbiddenPublicNames ?? [],
    );
    const skillContent = input.includeContent
      ? await readFile(path.join(skillDir, "SKILL.md"), "utf8")
      : undefined;
    learnedSkills.push({
      name: validated.skillName,
      displayName: titleizeSlug(validated.skillName),
      description: validated.frontmatter.description,
      relativePath: `${validated.skillDir}/SKILL.md`,
      supportingFiles: supportingFilesFromValidated(validated),
      ...(skillContent !== undefined ? { skillContent } : {}),
    });
  }

  return { skillsRoot, learnedSkills, skills: learnedSkills };
}

export function createLearnedSkillStore(
  options: CreateLearnedSkillStoreOptions,
): LearnedSkillStore {
  const skillsRoot = path.resolve(options.skillsRoot);
  const checkpointRoot = path.resolve(
    options.checkpointRoot ?? path.join(path.dirname(skillsRoot), ".memflywheel-skill-checkpoints"),
  );
  const forbiddenPublicNames = options.forbiddenPublicNames ?? [];

  return {
    getLearnedSkillsCatalog: (input = {}) =>
      getLearnedSkillsCatalog({
        skillsRoot,
        includeContent: input.includeContent,
        forbiddenPublicNames,
      }),
    createSkillCheckpoint: () =>
      createLearnedSkillStoreCheckpoint({
        skillsRoot,
        checkpointRoot,
      }),
    createFileTools: (checkpoint) =>
      createLearnedSkillFileTools({
        checkpoint,
      }),
    finalizeLearnedSkillChanges: async ({ checkpoint, learningSummary }) => {
      const result = await finalizeLearnedSkillStoreCheckpoint({
        checkpoint,
        forbiddenPublicNames,
        learningSummary,
      });
      return {
        changedSkills: result.changedSkills.map((skill) => skill.name),
        changedFiles: result.changedFiles,
      };
    },
    rollbackSkillCheckpoint: async (checkpoint) => {
      await rollbackLearnedSkillStoreCheckpoint(checkpoint);
    },
  };
}

export function createLearnedSkillRecallProvider(input: {
  skillsRoot: string;
  forbiddenPublicNames?: readonly string[];
}): LearnedSkillRecallProvider {
  return async () => {
    const skillsRoot = path.resolve(input.skillsRoot);
    const catalog = await getLearnedSkillsCatalog({
      skillsRoot,
      forbiddenPublicNames: input.forbiddenPublicNames,
    });
    return {
      entries: catalog.learnedSkills.map((entry) => ({
        name: entry.name,
        displayName: entry.displayName,
        description: entry.description,
        relativePath: path.join(skillsRoot, entry.relativePath),
        triggerHints: deriveTriggerHints(entry),
      })),
    };
  };
}

export function buildLearnedSkillPrelude(packet: LearnedSkillRecallPacket): string {
  if (packet.entries.length === 0) return "";

  const lines = ["<system-reminder>", "## Available Skills", ""];
  if (packet.entries.length === 0) {
    lines.push("No learned skills are currently available.");
  } else {
    for (const entry of packet.entries) {
      lines.push(`- ${entry.name}: ${entry.displayName} — ${entry.description}`);
      lines.push(`  path: ${entry.relativePath}`);
      if (entry.triggerHints.length > 0) {
        lines.push(`  triggers: ${entry.triggerHints.join(", ")}`);
      }
    }
  }

  lines.push(
    "",
    "Use the host-provided skill loading/execution capability only when the user request clearly matches a skill. Do not copy skill procedures into ordinary memory.",
    "</system-reminder>",
  );
  return lines.join("\n");
}

async function createLearnedSkillStoreCheckpoint(input: {
  skillsRoot: string;
  checkpointRoot: string;
}): Promise<LearnedSkillStoreCheckpoint> {
  const skillsRoot = path.resolve(input.skillsRoot);
  const checkpointRoot = path.resolve(input.checkpointRoot);
  assertSeparateRoots(skillsRoot, checkpointRoot);

  const checkpointId = randomUUID();
  const checkpointDir = path.join(checkpointRoot, checkpointId);
  const manifestPath = path.join(checkpointDir, STORE_CHECKPOINT_MANIFEST);
  const stageRoot = path.join(checkpointDir, "stage");
  const snapshotRoot = path.join(checkpointDir, "snapshot");
  const rootExisted = await pathExists(skillsRoot);

  await mkdir(checkpointRoot, { recursive: true });
  await mkdir(checkpointDir, { recursive: false });
  await mkdir(stageRoot, { recursive: true });
  await mkdir(snapshotRoot, { recursive: true });
  await mkdir(skillsRoot, { recursive: true });

  const beforeFiles = await listFileFingerprints(skillsRoot);
  if (rootExisted) {
    await copyTree(skillsRoot, stageRoot);
    await copyTree(skillsRoot, snapshotRoot);
  }

  const manifest: StoreCheckpointManifest = {
    version: 1,
    kind: "learned-skill-store",
    checkpointId,
    skillsRoot,
    checkpointRoot,
    stageRoot,
    snapshotRoot,
    rootExisted,
    beforeFiles,
  };
  await writeStoreCheckpointManifest(manifestPath, manifest);

  return { checkpointId, checkpointDir, manifestPath };
}

function createLearnedSkillFileTools(input: {
  checkpoint: LearnedSkillStoreCheckpoint;
}): LearnedSkillTool[] {
  return createCoreFileTools().map((tool) => bindStageFileTool(tool, input.checkpoint));
}

/** A token that begins with "/" — i.e. an absolute filesystem path. */
function commandUsesAbsolutePath(command: string): boolean {
  return /(?:^|[\s"'`=(<>|;&])\/[^\s/]/.test(command);
}

function bindStageFileTool(
  tool: FileTool,
  checkpoint: LearnedSkillStoreCheckpoint,
): LearnedSkillTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (args) => {
      // Defense in depth: the model only ever needs relative paths inside the staging
      // sandbox. bash with /bin/sh can otherwise escape via an absolute path, so reject
      // any absolute path in a skill-evolution bash command (legitimate uses — e.g.
      // "rm -rf <dup-dir>" for a merge — are always relative).
      if (tool.name === "bash") {
        const record = (args ?? {}) as { command?: unknown; workdir?: unknown };
        const command = typeof record.command === "string" ? record.command : "";
        const workdir = typeof record.workdir === "string" ? record.workdir : "";
        if (commandUsesAbsolutePath(command) || workdir.startsWith("/")) {
          return {
            ok: false,
            text: "bash in skill evolution must use RELATIVE paths only; absolute filesystem paths are not allowed. Use the write tool with a relative path like memflywheel-learned-<slug>/SKILL.md.",
          };
        }
      }
      const manifest = await readStoreCheckpointManifest(checkpoint.manifestPath);
      return tool.handler(args, { root: manifest.stageRoot, mode: "files" });
    },
  };
}

async function finalizeLearnedSkillStoreCheckpoint(input: {
  checkpoint: LearnedSkillStoreCheckpoint;
  forbiddenPublicNames: readonly string[];
  learningSummary?: unknown;
}): Promise<LearnedSkillChangeSet> {
  const manifest = await readStoreCheckpointManifest(input.checkpoint.manifestPath);
  const currentBeforeFinalize = await listFileFingerprints(manifest.skillsRoot);
  const finalizedTreeDiff = diffFingerprints(manifest.beforeFiles, currentBeforeFinalize);
  if (finalizedTreeDiff.deletedPaths.length > 0 || finalizedTreeDiff.changedPaths.length > 0) {
    const changed = finalizedTreeDiff.changedPaths.map((p) => `changed:${p}`);
    const deleted = finalizedTreeDiff.deletedPaths.map((p) => `deleted:${p}`);
    throw new FinalizeSafetyError(
      `finalize refuses finalized skill tree changes after checkpoint: ${[...changed, ...deleted].slice(0, 10).join(", ")}`,
    );
  }

  let stagedFiles = await listFileFingerprints(manifest.stageRoot);
  let stagedDiff = diffFingerprints(manifest.beforeFiles, stagedFiles);
  const allowedDeletedSkills = allowedMergedSkills(input.learningSummary);
  const deletedSkillNames = [
    ...new Set(stagedDiff.deletedPaths.map((relativePath) => relativePath.split("/")[0] ?? "")),
  ]
    .filter(Boolean)
    .sort();
  for (const skillName of deletedSkillNames) {
    if (!allowedDeletedSkills.has(skillName)) {
      throw new FinalizeSafetyError(
        `finalize refuses deleted learned skill paths outside mergedSkills: ${skillName}`,
      );
    }
    const beforeSkillFiles = manifest.beforeFiles.filter((file) =>
      isInSkillDir(file.relativePath, skillName),
    );
    const deletedSkillFiles = stagedDiff.deletedPaths.filter((relativePath) =>
      isInSkillDir(relativePath, skillName),
    );
    const changedDeletedSkillFiles = stagedDiff.changedPaths.filter((relativePath) =>
      isInSkillDir(relativePath, skillName),
    );
    if (
      beforeSkillFiles.length !== deletedSkillFiles.length ||
      changedDeletedSkillFiles.length > 0
    ) {
      throw new FinalizeSafetyError(
        `finalize refuses partial learned skill deletion: ${skillName}`,
      );
    }
  }

  let changedFiles = [...stagedDiff.changedPaths, ...stagedDiff.deletedPaths].sort();
  let changedSkillNames = [
    ...new Set(changedFiles.map((relativePath) => relativePath.split("/")[0] ?? "")),
  ]
    .filter(Boolean)
    .sort();
  const illegalDir = changedSkillNames.find((name) => !isLearnedSkillDirName(name));
  if (illegalDir) {
    throw new FinalizeSafetyError(
      `finalize refuses changes outside learned skill directories: ${illegalDir}`,
    );
  }

  const changedSkills: LearnedSkillChange[] = [];
  try {
    for (const skillName of changedSkillNames) {
      if (deletedSkillNames.includes(skillName)) {
        changedSkills.push({
          name: skillName,
          changedFiles: stagedDiff.deletedPaths.filter((relativePath) =>
            isInSkillDir(relativePath, skillName),
          ),
          supportingFiles: [],
        });
        await rm(path.join(manifest.skillsRoot, skillName), { recursive: true, force: true });
        continue;
      }
      const stagedSkillDir = path.join(manifest.stageRoot, skillName);
      const validated = await validateLearnedSkillDirectory(
        stagedSkillDir,
        input.forbiddenPublicNames,
      );
      const skillChangedFiles = stagedDiff.changedPaths
        .filter((relativePath) => isInSkillDir(relativePath, skillName))
        .sort();
      changedSkills.push({
        name: skillName,
        changedFiles: skillChangedFiles,
        supportingFiles: supportingFilesFromValidated(validated),
      });
      await rm(path.join(manifest.skillsRoot, skillName), { recursive: true, force: true });
      await copyTree(stagedSkillDir, path.join(manifest.skillsRoot, skillName));
    }
  } catch (error) {
    await restoreStoreSnapshot(manifest);
    throw error;
  }

  return {
    changedSkills,
    changedFiles,
  };
}

async function rollbackLearnedSkillStoreCheckpoint(
  checkpoint: LearnedSkillStoreCheckpoint,
): Promise<void> {
  const manifest = await readStoreCheckpointManifest(checkpoint.manifestPath);
  await restoreStoreSnapshot(manifest);
}

async function restoreStoreSnapshot(manifest: StoreCheckpointManifest): Promise<void> {
  await rm(manifest.skillsRoot, { recursive: true, force: true });
  if (manifest.rootExisted) {
    await copyTree(manifest.snapshotRoot, manifest.skillsRoot);
  } else {
    await mkdir(manifest.skillsRoot, { recursive: true });
  }
}

async function readSkillDirectoryFiles(
  skillDir: string,
): Promise<Record<string, LearnedSkillFileContent>> {
  const files: Record<string, LearnedSkillFileContent> = {};
  await collectSkillDirectoryFiles(skillDir, skillDir, files);
  return files;
}

async function collectSkillDirectoryFiles(
  root: string,
  current: string,
  out: Record<string, LearnedSkillFileContent>,
): Promise<void> {
  const stat = await lstat(current);
  if (stat.isSymbolicLink()) {
    throw new LearnedSkillValidationError(
      `symbolic links are not allowed in learned skill directories: ${current}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new LearnedSkillValidationError(`learned skill path must be a directory: ${current}`);
  }

  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(current, entry.name);
    const relativePath = toPosixRelative(root, filePath);
    if (entry.isSymbolicLink()) {
      throw new LearnedSkillValidationError(
        `symbolic links are not allowed in learned skill directories: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      await collectSkillDirectoryFiles(root, filePath, out);
      continue;
    }
    if (!entry.isFile()) {
      throw new LearnedSkillValidationError(
        `only regular files are allowed in learned skill directories: ${relativePath}`,
      );
    }
    const bytes = await readFile(filePath);
    out[relativePath] =
      relativePath === "SKILL.md" ? new TextDecoder("utf8", { fatal: true }).decode(bytes) : bytes;
  }
}

function supportingFilesFromValidated(
  validated: ValidatedLearnedSkillPackage,
): LearnedSkillSupportingFile[] {
  const fileByPath = new Map(validated.files.map((file) => [file.relativePath, file]));
  return validated.supportingFiles.map((relativePath) => {
    const [kind] = relativePath.split("/");
    const file = fileByPath.get(relativePath);
    if (!kind || !SUPPORTING_DIRS.includes(kind as (typeof SUPPORTING_DIRS)[number]) || !file) {
      throw new LearnedSkillValidationError(`invalid supporting file path: ${relativePath}`);
    }
    return {
      path: relativePath,
      kind: kind as (typeof SUPPORTING_DIRS)[number],
      sizeBytes: file.bytes.byteLength,
    };
  });
}

function deriveTriggerHints(entry: LearnedSkillCatalogEntry): string[] {
  const hints = new Set<string>();
  const display = normalizeTriggerHint(entry.displayName);
  if (display) hints.add(display);

  const description = normalizeTriggerHint(entry.description);
  const durablePhrase = description.match(/\bdurable\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,2}/)?.[0];
  if (durablePhrase) hints.add(durablePhrase);

  return [...hints];
}

function normalizeTriggerHint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^captures\s+/, "")
    .replace(/\s+habits?$/, "");
}

async function readStoreCheckpointManifest(manifestPath: string): Promise<StoreCheckpointManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as StoreCheckpointManifest;
  if (parsed.version !== 1 || parsed.kind !== "learned-skill-store") {
    throw new LearnedSkillValidationError("unsupported learned skill store checkpoint");
  }
  return parsed;
}

function allowedMergedSkills(learningSummary: unknown): Set<string> {
  const coordination =
    learningSummary && typeof learningSummary === "object"
      ? (learningSummary as { coordination?: unknown }).coordination
      : null;
  if (!coordination || typeof coordination !== "object" || Array.isArray(coordination)) {
    return new Set();
  }
  const record = coordination as { decision?: unknown; mergedSkills?: unknown };
  if (record.decision !== "merge" || !Array.isArray(record.mergedSkills)) {
    return new Set();
  }
  const out = new Set<string>();
  for (const skillName of record.mergedSkills) {
    if (typeof skillName === "string" && isLearnedSkillDirName(skillName)) {
      out.add(skillName);
    }
  }
  return out;
}

async function writeStoreCheckpointManifest(
  manifestPath: string,
  manifest: StoreCheckpointManifest,
): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseStringField(args: unknown, key: string): string {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null;
  const value = record?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LearnedSkillValidationError(`${key} must be a non-empty string`);
  }
  return value;
}

function _parseSkillFileArgs(args: unknown): { skillName: string; relativePath: string } {
  const skillName = parseSkillNameField(args, "skillName");
  const relativePath = normalizeSkillRelativePath(parseStringField(args, "relativePath"));
  assertAllowedSkillPath(relativePath);
  assertSafeFileName(relativePath);
  return { skillName, relativePath };
}

function parseSkillNameField(args: unknown, key: string): string {
  const skillName = parseStringField(args, key);
  if (!isLearnedSkillDirName(skillName)) {
    throw new LearnedSkillValidationError(`${key} must be ${LEARNED_SKILL_DIR_PREFIX}<slug>`);
  }
  return skillName;
}

function _resolveStageSkillFile(
  stageRoot: string,
  skillName: string,
  relativePath: string,
): string {
  const resolvedStageRoot = path.resolve(stageRoot);
  const resolved = path.resolve(resolvedStageRoot, skillName, relativePath);
  if (resolved !== resolvedStageRoot && !resolved.startsWith(resolvedStageRoot + path.sep)) {
    throw new LearnedSkillValidationError("skill file path escapes stage root");
  }
  return resolved;
}

function isLearnedSkillDirName(value: string): boolean {
  if (!value.startsWith(LEARNED_SKILL_DIR_PREFIX)) return false;
  return SLUG_RE.test(value.slice(LEARNED_SKILL_DIR_PREFIX.length));
}

function validateSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new LearnedSkillValidationError("learned skill slug must be lowercase kebab-case");
  }
  return slug;
}

function normalizeFiles(
  files: Record<string, LearnedSkillFileContent>,
  forbiddenPublicNames: readonly string[],
): NormalizedLearnedSkillFile[] {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new LearnedSkillValidationError("learned skill package must contain files");
  }

  const normalized: NormalizedLearnedSkillFile[] = [];
  const seen = new Set<string>();
  for (const [rawRelativePath, content] of entries) {
    const relativePath = normalizeSkillRelativePath(rawRelativePath);
    if (seen.has(relativePath)) {
      throw new LearnedSkillValidationError(`duplicate skill file path: ${relativePath}`);
    }
    seen.add(relativePath);

    assertAllowedSkillPath(relativePath);
    assertSafeFileName(relativePath);
    const { bytes, text } = normalizeContent(relativePath, content);

    if (SUPPORTING_DIRS.some((dir) => relativePath.startsWith(`${dir}/`))) {
      if (bytes.byteLength === 0) {
        throw new LearnedSkillValidationError(`supporting file must be non-empty: ${relativePath}`);
      }
      if (bytes.byteLength > MAX_SUPPORTING_FILE_BYTES) {
        throw new LearnedSkillValidationError(
          `supporting file exceeds 1048576 bytes: ${relativePath}`,
        );
      }
    }

    if (text !== undefined) {
      assertNoForbiddenPublicNames(relativePath, text, forbiddenPublicNames);
    }

    normalized.push({ relativePath, bytes, text });
  }

  return normalized;
}

function normalizeSkillRelativePath(rawRelativePath: string): string {
  if (rawRelativePath.length === 0 || rawRelativePath.trim() !== rawRelativePath) {
    throw new LearnedSkillValidationError("skill file path must be non-empty and trimmed");
  }
  if (rawRelativePath.startsWith("/") || rawRelativePath.includes("\\")) {
    throw new LearnedSkillValidationError(
      `skill file path must be relative POSIX path: ${rawRelativePath}`,
    );
  }
  const parts = rawRelativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new LearnedSkillValidationError(
      `skill file path must not contain empty, dot, or parent segments: ${rawRelativePath}`,
    );
  }
  return rawRelativePath;
}

function assertAllowedSkillPath(relativePath: string): void {
  if (relativePath === "SKILL.md") {
    return;
  }
  const [top] = relativePath.split("/");
  if (!top || !SUPPORTING_DIRS.includes(top as (typeof SUPPORTING_DIRS)[number])) {
    throw new LearnedSkillValidationError(
      `supporting files must live under references/, templates/, scripts/, or assets/: ${relativePath}`,
    );
  }
  if (!relativePath.includes("/")) {
    throw new LearnedSkillValidationError(`supporting file must include a file name under ${top}/`);
  }
}

function assertSafeFileName(relativePath: string): void {
  const basename = path.posix.basename(relativePath);
  const lower = basename.toLowerCase();
  if (
    SENSITIVE_FILE_BASENAMES.has(lower) ||
    SENSITIVE_FILE_NAME_PATTERNS.some((pattern) => pattern.test(lower))
  ) {
    throw new LearnedSkillValidationError(`sensitive file name is not allowed: ${relativePath}`);
  }
}

function normalizeContent(
  relativePath: string,
  content: LearnedSkillFileContent,
): { bytes: Uint8Array; text?: string } {
  if (typeof content === "string") {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength === 0 && relativePath === "SKILL.md") {
      throw new LearnedSkillValidationError(
        `required text file must be non-empty: ${relativePath}`,
      );
    }
    return { bytes, text: content };
  }

  if (relativePath === "SKILL.md") {
    throw new LearnedSkillValidationError(`${relativePath} must be provided as text`);
  }
  return { bytes: content };
}

function assertNoForbiddenPublicNames(
  relativePath: string,
  text: string,
  forbiddenPublicNames: readonly string[],
): void {
  const lowerText = text.toLowerCase();
  for (const name of forbiddenPublicNames) {
    if (name.length === 0) continue;
    if (lowerText.includes(name.toLowerCase())) {
      throw new LearnedSkillValidationError(`forbidden public name appears in ${relativePath}`);
    }
  }
}

function titleizeSlug(skillName: string): string {
  return skillName
    .replace(new RegExp(`^${LEARNED_SKILL_DIR_PREFIX}`), "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseSkillFrontmatter(content: string, expectedName: string): LearnedSkillFrontmatter {
  const fallback = {
    name: expectedName,
    description: "Learned skill.",
  };
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return fallback;
  }

  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1) {
    return fallback;
  }

  const meta = new Map<string, string>();
  for (const line of lines.slice(1, endIndex)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (value.length > 0 && !meta.has(key)) meta.set(key, value);
  }

  return {
    name: meta.get("name") || fallback.name,
    description: meta.get("description") || fallback.description,
  };
}

async function readCheckpointManifest(manifestPath: string): Promise<CheckpointManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as CheckpointManifest;
  if (parsed.version !== 1) {
    throw new LearnedSkillValidationError("unsupported learned skill checkpoint version");
  }
  return parsed;
}

function assertSeparateRoots(skillsRoot: string, checkpointRoot: string): void {
  if (
    skillsRoot === checkpointRoot ||
    isInsidePath(checkpointRoot, skillsRoot) ||
    isInsidePath(skillsRoot, checkpointRoot)
  ) {
    throw new LearnedSkillValidationError("checkpointRoot must be outside skillsRoot");
  }
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInSkillDir(relativePath: string, skillDir: string): boolean {
  return relativePath === skillDir || relativePath.startsWith(`${skillDir}/`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyTree(sourceDir: string, targetDir: string): Promise<void> {
  const sourceStat = await lstat(sourceDir);
  if (sourceStat.isSymbolicLink()) {
    throw new FinalizeSafetyError(
      `symbolic links are not allowed in learned skill trees: ${sourceDir}`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new FinalizeSafetyError(`copyTree source must be a directory: ${sourceDir}`);
  }

  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new FinalizeSafetyError(
        `symbolic links are not allowed in learned skill trees: ${sourcePath}`,
      );
    }
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new FinalizeSafetyError(
        `only regular files are allowed in learned skill trees: ${sourcePath}`,
      );
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

async function listFileFingerprints(root: string): Promise<FileFingerprint[]> {
  if (!(await pathExists(root))) return [];
  const out: FileFingerprint[] = [];
  await collectFileFingerprints(root, root, out);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function collectFileFingerprints(
  root: string,
  current: string,
  out: FileFingerprint[],
): Promise<void> {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) {
    throw new FinalizeSafetyError(`symbolic links are not allowed in skillsRoot: ${current}`);
  }
  if (!currentStat.isDirectory()) {
    throw new FinalizeSafetyError(`skillsRoot entries must be directories or files: ${current}`);
  }

  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new FinalizeSafetyError(`symbolic links are not allowed in skillsRoot: ${filePath}`);
    }
    if (entry.isDirectory()) {
      await collectFileFingerprints(root, filePath, out);
      continue;
    }
    if (!entry.isFile()) {
      throw new FinalizeSafetyError(`skillsRoot entries must be regular files: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    out.push({
      relativePath: toPosixRelative(root, filePath),
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function diffFingerprints(
  before: FileFingerprint[],
  after: FileFingerprint[],
): { changedPaths: string[]; deletedPaths: string[] } {
  const beforeMap = new Map(before.map((file) => [file.relativePath, file]));
  const afterMap = new Map(after.map((file) => [file.relativePath, file]));
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];

  for (const [relativePath, beforeFile] of beforeMap) {
    const afterFile = afterMap.get(relativePath);
    if (!afterFile) {
      deletedPaths.push(relativePath);
      continue;
    }
    if (beforeFile.sha256 !== afterFile.sha256 || beforeFile.size !== afterFile.size) {
      changedPaths.push(relativePath);
    }
  }

  for (const relativePath of afterMap.keys()) {
    if (!beforeMap.has(relativePath)) {
      changedPaths.push(relativePath);
    }
  }

  return { changedPaths: changedPaths.sort(), deletedPaths: deletedPaths.sort() };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
