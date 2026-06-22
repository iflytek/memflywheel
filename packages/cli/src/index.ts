#!/usr/bin/env node
/**
 * @memscribe/cli — the local governance loop over a MemScribe memory root.
 *
 * Commands: init / list / read / context / write / doctor / rebuild-index /
 * dream (plan|apply) / mcp.
 *
 * The CLI never calls an LLM. `dream apply` runs only the deterministic plan;
 * `write` is the deterministic, manual equivalent of writing a validated typed
 * Markdown file. Both LLM injection points live in the SDK, not here.
 */

import { spawn } from "node:child_process";

import {
  type StorageContext,
  type MemoryEntry,
  type MemoryDocument,
  type HealthFinding,
  getMemoryRoot,
  ensureMemoryDir,
  isMemoryType,
  VALID_MEMORY_TYPES,
  scanMemoryFiles,
  readMemoryDocument,
  writeMemoryDocument,
  createAuditLogger,
  createNullAuditLogger,
  buildContext,
  syncMemoryIndex,
  buildHealthFindings,
  planDream,
  applyDream,
} from "@memscribe/core";

export interface CliResult {
  /** Process exit code. 0 = success. */
  code: number;
  /** Lines to print to stdout. */
  stdout: string[];
  /** Lines to print to stderr. */
  stderr: string[];
}

export interface CliDeps {
  /** Read all of stdin as a string. Injected so tests need no real stdin. */
  readStdin: () => Promise<string>;
}

// ---- argument parsing -------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positionals: string[];
  options: Record<string, string | boolean>;
}

/**
 * Minimal flag parser: `--key value`, `--key=value`, and boolean `--flag`.
 * The first non-option token is the command; remaining non-options are positionals.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[body] = next;
        i += 1;
      } else {
        options[body] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  const command = positionals.shift() ?? "";
  return { command, positionals, options };
}

function optString(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function resolveRoot(options: Record<string, string | boolean>): string {
  return getMemoryRoot({ root: optString(options, "root") });
}

function makeStorageContext(
  root: string,
  options: Record<string, string | boolean>,
): StorageContext {
  const audit = options["no-audit"] ? createNullAuditLogger() : createAuditLogger(root);
  return { root, audit };
}

// ---- help -------------------------------------------------------------------

const HELP = `memscribe — file-backed memory governance

Usage: memscribe <command> [options]

Commands:
  init                       Create the memory root directory
  list                       List memory entries (mtime DESC)
  read <relativePath>        Print one memory document
  context                    Print the two-segment recall injection
  write                      Create/update a memory (flags or --stdin body)
  doctor                     Report structural health findings
  rebuild-index              Regenerate MEMORY.md from disk
  dream plan                 Print the deterministic consolidation plan
  dream apply                Apply the deterministic consolidation plan
  mcp                        Launch the MemScribe MCP server (stdio)

Global options:
  --root <dir>               Memory root (else MEMSCRIBE_HOME / OS data dir)
  --json                     Machine-readable output where supported
  --no-audit                 Do not write the audit log for this invocation

write options (manual typed Markdown write):
  --type <type>              identity preference style workflow context ambient
  --filename <name.md>       Flat *.md filename (optional; derived from --name)
  --name <name>              Frontmatter name (required)
  --description <text>       Frontmatter description
  --body <text>              Body text (or --stdin to read body from stdin)
  --stdin                    Read the body from stdin
`;

// ---- commands ---------------------------------------------------------------

async function cmdInit(root: string): Promise<CliResult> {
  await ensureMemoryDir(root);
  return { code: 0, stdout: [`Initialized memory root at ${root}`], stderr: [] };
}

async function cmdList(root: string, json: boolean): Promise<CliResult> {
  const entries = await scanMemoryFiles(root);
  if (json) {
    return { code: 0, stdout: [JSON.stringify(entries, null, 2)], stderr: [] };
  }
  if (entries.length === 0) {
    return { code: 0, stdout: ["(no memories)"], stderr: [] };
  }
  const lines = entries.map((e: MemoryEntry) => {
    const date = new Date(e.mtime).toISOString().slice(0, 10);
    return `[${e.type}] ${e.relativePath} (${date}) - ${e.name}${
      e.description ? `: ${e.description}` : ""
    }`;
  });
  return { code: 0, stdout: lines, stderr: [] };
}

async function cmdRead(
  root: string,
  relativePath: string | undefined,
  json: boolean,
): Promise<CliResult> {
  if (!relativePath) {
    return { code: 2, stdout: [], stderr: ["read: missing <relativePath>"] };
  }
  const ctx: StorageContext = { root, audit: createNullAuditLogger() };
  const doc = await readMemoryDocument(ctx, relativePath);
  if (!doc) {
    return { code: 1, stdout: [], stderr: [`read: not found: ${relativePath}`] };
  }
  if (json) {
    return { code: 0, stdout: [JSON.stringify(doc, null, 2)], stderr: [] };
  }
  const fm = doc.frontmatter;
  const header = [
    `name: ${fm.name}`,
    `type: ${fm.type}`,
    `description: ${fm.description ?? ""}`,
    fm.created_at ? `created_at: ${fm.created_at}` : "",
    fm.updated_at ? `updated_at: ${fm.updated_at}` : "",
  ].filter(Boolean);
  return { code: 0, stdout: [...header, "", doc.body], stderr: [] };
}

async function cmdContext(root: string, json: boolean): Promise<CliResult> {
  const result = await buildContext({ root });
  if (json) {
    return { code: 0, stdout: [JSON.stringify(result, null, 2)], stderr: [] };
  }
  return { code: 0, stdout: [result.systemPrompt, "", result.preludePrompt], stderr: [] };
}

/** Derive a slug filename from a memory name when --filename is omitted. */
function toFilename(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "memory"}.md`;
}

async function cmdWrite(
  root: string,
  options: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<CliResult> {
  const type = optString(options, "type");
  const rawFilename = optString(options, "filename");
  const name = optString(options, "name");
  const description = optString(options, "description");

  if (!type || !isMemoryType(type)) {
    return {
      code: 2,
      stdout: [],
      stderr: [`write: --type must be one of ${[...VALID_MEMORY_TYPES].join(" ")}`],
    };
  }
  if (!name) {
    return { code: 2, stdout: [], stderr: ["write: --name is required"] };
  }
  // --filename is optional: derive a slug from --name when omitted.
  const filename = rawFilename ?? toFilename(name);

  let body = optString(options, "body");
  if (options["stdin"]) {
    body = await deps.readStdin();
  }
  if (body === undefined) {
    return { code: 2, stdout: [], stderr: ["write: provide --body or --stdin"] };
  }

  const ctx = makeStorageContext(root, options);
  const doc: MemoryDocument = {
    frontmatter: { name, description: description ?? "", type },
    body,
  };
  try {
    const rel = await writeMemoryDocument(ctx, { type, filename, doc });
    await syncMemoryIndex(root);
    return { code: 0, stdout: [`Wrote ${rel}`], stderr: [] };
  } catch (err) {
    return { code: 1, stdout: [], stderr: [`write: ${(err as Error).message}`] };
  }
}

function formatFinding(f: HealthFinding): string {
  return `${f.severity.toUpperCase()} [${f.code}] ${f.paths.join(", ")} - ${f.message}`;
}

async function cmdDoctor(root: string, json: boolean): Promise<CliResult> {
  const findings = await buildHealthFindings(root);
  const hasError = findings.some((f) => f.severity === "error");
  if (json) {
    return {
      code: hasError ? 1 : 0,
      stdout: [JSON.stringify(findings, null, 2)],
      stderr: [],
    };
  }
  if (findings.length === 0) {
    return { code: 0, stdout: ["No issues found."], stderr: [] };
  }
  return { code: hasError ? 1 : 0, stdout: findings.map(formatFinding), stderr: [] };
}

async function cmdRebuildIndex(root: string): Promise<CliResult> {
  const content = await syncMemoryIndex(root);
  const count = content ? content.split("\n").filter(Boolean).length : 0;
  return {
    code: 0,
    stdout: [`Rebuilt MEMORY.md (${count} entr${count === 1 ? "y" : "ies"})`],
    stderr: [],
  };
}

function describeOp(op: { kind: string } & Record<string, unknown>): string {
  switch (op.kind) {
    case "delete-duplicate":
      return `  delete-duplicate: ${op["path"]}`;
    case "relocate":
      return `  relocate: ${op["path"]} -> ${op["toType"]}`;
    default:
      return `  ${op.kind}`;
  }
}

async function cmdDream(
  root: string,
  sub: string | undefined,
  options: Record<string, string | boolean>,
): Promise<CliResult> {
  const json = Boolean(options["json"]);

  if (sub === "plan") {
    const ops = await planDream({ root });
    if (json) {
      return { code: 0, stdout: [JSON.stringify(ops, null, 2)], stderr: [] };
    }
    if (ops.length === 0) {
      return { code: 0, stdout: ["Plan is empty (nothing to consolidate)."], stderr: [] };
    }
    return {
      code: 0,
      stdout: [`Plan (${ops.length} op${ops.length === 1 ? "" : "s"}):`, ...ops.map(describeOp)],
      stderr: [],
    };
  }

  if (sub === "apply") {
    const ctx = makeStorageContext(root, options);
    const plan = await planDream({ root });
    const result = await applyDream({ ctx, plan });
    if (json) {
      return { code: 0, stdout: [JSON.stringify(result, null, 2)], stderr: [] };
    }
    return {
      code: 0,
      stdout: [
        `Applied. changed=${result.changed.length} deleted=${result.deleted.length}`,
        ...result.changed.map((p) => `  changed: ${p}`),
        ...result.deleted.map((p) => `  deleted: ${p}`),
      ],
      stderr: [],
    };
  }

  return { code: 2, stdout: [], stderr: ["dream: expected subcommand 'plan' or 'apply'"] };
}

/**
 * Launch the MCP server (stdio) by spawning its bin and forwarding stdio.
 * Kept as a thin process launcher so MCP wiring stays in its own package.
 */
async function cmdMcp(options: Record<string, string | boolean>): Promise<CliResult> {
  const root = optString(options, "root");
  const env = { ...process.env };
  if (root) env["MEMSCRIBE_HOME"] = root;

  return new Promise<CliResult>((resolve) => {
    const child = spawn("memscribe-mcp", [], { stdio: "inherit", env });
    child.on("error", (err) => {
      resolve({
        code: 1,
        stdout: [],
        stderr: [
          `mcp: failed to launch memscribe-mcp: ${(err as Error).message}`,
          "Install @memscribe/mcp-server to use this command.",
        ],
      });
    });
    child.on("exit", (childCode) => {
      resolve({ code: childCode ?? 0, stdout: [], stderr: [] });
    });
  });
}

// ---- dispatch ---------------------------------------------------------------

/**
 * Pure dispatcher: takes argv (without node/script), returns a CliResult.
 * No process.exit / console here — the thin `main` wrapper does I/O.
 */
export async function run(argv: string[], deps: CliDeps): Promise<CliResult> {
  const { command, positionals, options } = parseArgs(argv);
  const json = Boolean(options["json"]);

  if (!command || command === "help" || options["help"]) {
    return { code: command ? 0 : 1, stdout: [HELP], stderr: [] };
  }

  const root = resolveRoot(options);

  switch (command) {
    case "init":
      return cmdInit(root);
    case "list":
      return cmdList(root, json);
    case "read":
      return cmdRead(root, positionals[0], json);
    case "context":
      return cmdContext(root, json);
    case "write":
      return cmdWrite(root, options, deps);
    case "doctor":
      return cmdDoctor(root, json);
    case "rebuild-index":
      return cmdRebuildIndex(root);
    case "dream":
      return cmdDream(root, positionals[0], options);
    case "mcp":
      return cmdMcp(options);
    default:
      return { code: 2, stdout: [], stderr: [`unknown command: ${command}`, "", HELP] };
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Process entry point: wires real stdin and prints the result. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const result = await run(argv, { readStdin: readAllStdin });
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  return result.code;
}

// Run only when invoked as a script (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
const isMain = invokedPath.endsWith("index.js") || invokedPath.endsWith("memscribe");

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`memscribe: ${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
