/**
 * CLI tests. Every command is exercised through the pure `run()` dispatcher with
 * an injected stdin and an isolated temp root — no process spawning, no real I/O
 * leakage. (The `mcp` command spawns a child and is intentionally not tested
 * here; it is a thin launcher with no logic of its own.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run, parseArgs, type CliDeps, type CliResult } from "./index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "memscribe-cli-"));
}

function deps(stdin = ""): CliDeps {
  return { readStdin: async () => stdin };
}

async function call(argv: string[], stdin = ""): Promise<CliResult> {
  return run(argv, deps(stdin));
}

function joined(result: CliResult): string {
  return [...result.stdout, ...result.stderr].join("\n");
}

// ---- parseArgs --------------------------------------------------------------

test("parseArgs: command, positionals, value flags, =flags, boolean flags", () => {
  const parsed = parseArgs([
    "write",
    "pos1",
    "--type",
    "style",
    "--filename=tone.md",
    "--stdin",
  ]);
  assert.equal(parsed.command, "write");
  assert.deepEqual(parsed.positionals, ["pos1"]);
  assert.equal(parsed.options["type"], "style");
  assert.equal(parsed.options["filename"], "tone.md");
  assert.equal(parsed.options["stdin"], true);
});

test("parseArgs: empty argv yields empty command", () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, "");
  assert.deepEqual(parsed.positionals, []);
});

// ---- help / unknown ---------------------------------------------------------

test("no command prints help with non-zero code", async () => {
  const r = await call([]);
  assert.equal(r.code, 1);
  assert.match(joined(r), /Usage: memscribe/);
});

test("help command prints help with code 0", async () => {
  const r = await call(["help"]);
  assert.equal(r.code, 0);
  assert.match(joined(r), /Commands:/);
});

test("unknown command exits 2", async () => {
  const r = await call(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(joined(r), /unknown command: frobnicate/);
});

// ---- init -------------------------------------------------------------------

test("init creates the memory root", async () => {
  const root = await makeRoot();
  const target = path.join(root, "store");
  try {
    const r = await call(["init", "--root", target]);
    assert.equal(r.code, 0);
    assert.match(joined(r), /Initialized memory root/);
    const st = await stat(target);
    assert.ok(st.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- write + list + read + rebuild-index ------------------------------------

test("write (flags) then list then read round-trips a memory", async () => {
  const root = await makeRoot();
  try {
    const w = await call([
      "write",
      "--root",
      root,
      "--type",
      "style",
      "--filename",
      "tone.md",
      "--name",
      "Tone",
      "--description",
      "prefers concise replies",
      "--body",
      "Keep answers short and direct.",
    ]);
    assert.equal(w.code, 0, joined(w));
    assert.match(joined(w), /Wrote style\/tone\.md/);

    // MEMORY.md was synced.
    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.match(index, /\[Tone\]/);

    const list = await call(["list", "--root", root]);
    assert.equal(list.code, 0);
    assert.match(joined(list), /\[style\] style\/tone\.md/);

    const read = await call(["read", "style/tone.md", "--root", root]);
    assert.equal(read.code, 0);
    assert.match(joined(read), /name: Tone/);
    assert.match(joined(read), /Keep answers short and direct\./);

    const listJson = await call(["list", "--root", root, "--json"]);
    const entries = JSON.parse(listJson.stdout[0] as string);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "style");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write reads body from stdin when --stdin is given", async () => {
  const root = await makeRoot();
  try {
    const w = await call(
      [
        "write",
        "--root",
        root,
        "--type",
        "context",
        "--filename",
        "proj.md",
        "--name",
        "Project",
        "--stdin",
      ],
      "Working on the MemScribe open-source library.",
    );
    assert.equal(w.code, 0, joined(w));
    const read = await call(["read", "context/proj.md", "--root", root]);
    assert.match(joined(read), /MemScribe open-source library/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write rejects an invalid type", async () => {
  const root = await makeRoot();
  try {
    const w = await call([
      "write",
      "--root",
      root,
      "--type",
      "bogus",
      "--filename",
      "x.md",
      "--name",
      "X",
      "--body",
      "y",
    ]);
    assert.equal(w.code, 2);
    assert.match(joined(w), /--type must be one of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read of a missing file exits 1", async () => {
  const root = await makeRoot();
  try {
    const r = await call(["read", "style/nope.md", "--root", root]);
    assert.equal(r.code, 1);
    assert.match(joined(r), /not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild-index regenerates MEMORY.md", async () => {
  const root = await makeRoot();
  try {
    await call([
      "write",
      "--root",
      root,
      "--type",
      "preference",
      "--filename",
      "a.md",
      "--name",
      "A",
      "--body",
      "alpha",
    ]);
    // Wipe MEMORY.md then rebuild.
    await writeFile(path.join(root, "MEMORY.md"), "stale");
    const r = await call(["rebuild-index", "--root", root]);
    assert.equal(r.code, 0);
    const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
    assert.match(index, /\[A\]/);
    assert.doesNotMatch(index, /stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- context ----------------------------------------------------------------

test("context prints both recall segments", async () => {
  const root = await makeRoot();
  try {
    const r = await call(["context", "--root", root]);
    assert.equal(r.code, 0);
    const text = joined(r);
    assert.match(text, /# 记忆/);
    assert.match(text, /<system-reminder>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- doctor -----------------------------------------------------------------

test("doctor reports no issues on a clean store", async () => {
  const root = await makeRoot();
  try {
    await call([
      "write",
      "--root",
      root,
      "--type",
      "workflow",
      "--filename",
      "w.md",
      "--name",
      "W",
      "--body",
      "do the thing",
    ]);
    const r = await call(["doctor", "--root", root]);
    assert.equal(r.code, 0);
    assert.match(joined(r), /No issues found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor flags a path/type mismatch with a non-zero code", async () => {
  const root = await makeRoot();
  try {
    // Place a style-typed file under the workflow directory.
    const dir = path.join(root, "workflow");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "bad.md"),
      "---\nname: Bad\ndescription: \ntype: style\n---\n\nbody\n",
    );
    const r = await call(["doctor", "--root", root]);
    assert.equal(r.code, 1);
    assert.match(joined(r), /path-type-mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- dream ------------------------------------------------------------------

test("dream plan on a clean store is empty", async () => {
  const root = await makeRoot();
  try {
    await call([
      "write",
      "--root",
      root,
      "--type",
      "style",
      "--filename",
      "s.md",
      "--name",
      "S",
      "--body",
      "unique body one",
    ]);
    const r = await call(["dream", "plan", "--root", root]);
    assert.equal(r.code, 0);
    assert.match(joined(r), /Plan is empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dream plan/apply removes a content duplicate", async () => {
  const root = await makeRoot();
  try {
    const body = "the exact same body across two files";
    await call([
      "write",
      "--root",
      root,
      "--type",
      "style",
      "--filename",
      "one.md",
      "--name",
      "One",
      "--body",
      body,
    ]);
    await call([
      "write",
      "--root",
      root,
      "--type",
      "style",
      "--filename",
      "two.md",
      "--name",
      "Two",
      "--body",
      body,
    ]);

    const plan = await call(["dream", "plan", "--root", root, "--json"]);
    const planOps = JSON.parse(plan.stdout[0] as string);
    assert.ok(planOps.some((op: { kind: string }) => op.kind === "delete-duplicate"));

    const apply = await call(["dream", "apply", "--root", root, "--json"]);
    assert.equal(apply.code, 0);
    const result = JSON.parse(apply.stdout[0] as string);
    assert.equal(result.deleted.length, 1);

    const list = await call(["list", "--root", root, "--json"]);
    const entries = JSON.parse(list.stdout[0] as string);
    assert.equal(entries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dream without a subcommand exits 2", async () => {
  const root = await makeRoot();
  try {
    const r = await call(["dream", "--root", root]);
    assert.equal(r.code, 2);
    assert.match(joined(r), /expected subcommand/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
