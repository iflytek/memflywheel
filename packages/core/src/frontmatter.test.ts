import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseFrontmatter,
  parseDocument,
  stripFrontmatter,
  serializeDocument,
  isSingleLineValue,
} from "./frontmatter.js";

test("parseFrontmatter requires name and type", () => {
  assert.equal(parseFrontmatter("no frontmatter"), null);
  assert.equal(parseFrontmatter("---\ndescription: x\n---\nbody"), null);
  assert.equal(parseFrontmatter("---\nname: a\n---\nbody"), null);
});

test("parseFrontmatter rejects invalid type", () => {
  assert.equal(parseFrontmatter("---\nname: a\ntype: bogus\n---\nbody"), null);
});

test("parseFrontmatter defaults description to empty string", () => {
  const fm = parseFrontmatter("---\nname: 用户称呼\ntype: identity\n---\n叫小钟");
  assert.deepEqual(fm, { name: "用户称呼", description: "", type: "identity" });
});

test("parseFrontmatter rejects closing fence beyond 30 lines", () => {
  const padded = "---\n" + "x: y\n".repeat(31) + "name: a\ntype: identity\n---\nbody";
  assert.equal(parseFrontmatter(padded), null);
});

test("stripFrontmatter returns trimmed body", () => {
  assert.equal(stripFrontmatter("---\nname: a\ntype: style\n---\n\nhello\n"), "hello");
  assert.equal(stripFrontmatter("plain text"), "plain text");
});

test("parseDocument splits frontmatter and body", () => {
  const doc = parseDocument("---\nname: n\ndescription: d\ntype: workflow\n---\n\nbody text");
  assert.ok(doc);
  assert.equal(doc?.frontmatter.type, "workflow");
  assert.equal(doc?.body, "body text");
});

test("serializeDocument is round-trippable and ordered", () => {
  const serialized = serializeDocument({
    frontmatter: {
      name: "name",
      description: "desc",
      type: "preference",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    },
    body: "the body",
  });
  const lines = serialized.split("\n");
  assert.equal(lines[0], "---");
  assert.equal(lines[1], "name: name");
  assert.equal(lines[2], "description: desc");
  assert.equal(lines[3], "type: preference");
  assert.equal(lines[4], "created_at: 2026-01-01T00:00:00.000Z");
  assert.equal(lines[5], "updated_at: 2026-01-02T00:00:00.000Z");

  const reparsed = parseDocument(serialized);
  assert.equal(reparsed?.frontmatter.name, "name");
  assert.equal(reparsed?.body, "the body");
});

test("serializeDocument round-trips occurred_on after the write times", () => {
  const serialized = serializeDocument({
    frontmatter: {
      name: "Support Group",
      description: "When the user attended",
      type: "context",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
      occurred_on: "2023-05-07",
    },
    body: "The user attended an LGBTQ support group on 2023-05-07.",
  });
  const lines = serialized.split("\n");
  assert.equal(lines[6], "occurred_on: 2023-05-07");

  const reparsed = parseFrontmatter(serialized);
  assert.equal(reparsed?.occurred_on, "2023-05-07");
});

test("parseFrontmatter omits occurred_on when absent", () => {
  const fm = parseFrontmatter("---\nname: a\ntype: identity\n---\nbody");
  assert.equal(fm?.occurred_on, undefined);
});

test("isSingleLineValue detects newlines", () => {
  assert.equal(isSingleLineValue("one line"), true);
  assert.equal(isSingleLineValue("two\nlines"), false);
});
