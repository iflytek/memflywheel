import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  getMemoryRoot,
  isValidMemoryFilename,
  getTypedMemoryDir,
  getTypedMemoryPath,
  resolveRelativePath,
  normalizeRelativePath,
  memoryTypeForRelativePath,
} from "./paths.js";

const ROOT = "/tmp/memflywheel-root";

test("getMemoryRoot honors explicit root then MEMFLYWHEEL_HOME", () => {
  assert.equal(getMemoryRoot({ root: "/x/y" }), path.resolve("/x/y"));
  const prev = process.env.MEMFLYWHEEL_HOME;
  process.env.MEMFLYWHEEL_HOME = "/env/mem";
  assert.equal(getMemoryRoot(), path.resolve("/env/mem"));
  if (prev === undefined) delete process.env.MEMFLYWHEEL_HOME;
  else process.env.MEMFLYWHEEL_HOME = prev;
});

test("isValidMemoryFilename accepts a flat .md name", () => {
  assert.equal(isValidMemoryFilename(ROOT, "user-name.md"), true);
});

test("isValidMemoryFilename rejects traversal, hidden, absolute, reserved, non-md", () => {
  assert.equal(isValidMemoryFilename(ROOT, "../escape.md"), false);
  assert.equal(isValidMemoryFilename(ROOT, ".hidden.md"), false);
  assert.equal(isValidMemoryFilename(ROOT, "/abs.md"), false);
  assert.equal(isValidMemoryFilename(ROOT, "MEMORY.md"), false);
  assert.equal(isValidMemoryFilename(ROOT, "note.txt"), false);
  assert.equal(isValidMemoryFilename(ROOT, "a\0b.md"), false);
  assert.equal(isValidMemoryFilename(ROOT, ""), false);
});

test("isValidMemoryFilename allows nested typed path", () => {
  assert.equal(isValidMemoryFilename(ROOT, "identity/user-name.md"), true);
});

test("getTypedMemoryDir maps known types only", () => {
  assert.equal(getTypedMemoryDir(ROOT, "identity"), path.join(ROOT, "identity"));
  assert.equal(getTypedMemoryDir(ROOT, "bogus"), null);
});

test("getTypedMemoryPath rejects nested filenames", () => {
  assert.equal(
    getTypedMemoryPath(ROOT, "identity", "user.md"),
    path.join(ROOT, "identity", "user.md"),
  );
  assert.equal(getTypedMemoryPath(ROOT, "identity", "sub/user.md"), null);
  assert.equal(getTypedMemoryPath(ROOT, "bogus", "user.md"), null);
});

test("resolveRelativePath stays inside root", () => {
  assert.equal(resolveRelativePath(ROOT, "identity/u.md"), path.join(ROOT, "identity", "u.md"));
  assert.equal(resolveRelativePath(ROOT, "../out.md"), null);
  assert.equal(resolveRelativePath(ROOT, "/abs.md"), null);
});

test("normalizeRelativePath converts backslashes", () => {
  assert.equal(normalizeRelativePath("identity\\u.md"), "identity/u.md");
});

test("memoryTypeForRelativePath reads the first segment", () => {
  assert.equal(memoryTypeForRelativePath("workflow/x.md"), "workflow");
  assert.equal(memoryTypeForRelativePath("nope/x.md"), null);
});
