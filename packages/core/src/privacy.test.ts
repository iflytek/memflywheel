import { test } from "node:test";
import assert from "node:assert/strict";

import {
  redactPrivateSpans,
  scanSecrets,
  enforceWritePrivacy,
  SecretRefusedError,
} from "./privacy.js";

const fakeOpenAiKey = "sk" + "-abcdefghijklmnopqrstuvwx";
const fakeGithubToken = "ghp" + "_0123456789abcdef0123456789abcdef";
const fakePasswordAssignment = "pass" + "word: hunter2xx";
const fakeApiKeyAssignment = "api" + "_key: supersecretvalue123";

test("redactPrivateSpans replaces private spans", () => {
  assert.equal(redactPrivateSpans("a <private>secret</private> b"), "a [REDACTED] b");
  assert.equal(
    redactPrivateSpans("x <private>line1\nline2</private> y"),
    "x [REDACTED] y",
  );
});

test("scanSecrets flags obvious secrets", () => {
  assert.equal(scanSecrets("nothing here").length, 0);
  assert.ok(scanSecrets(`token ${fakeOpenAiKey}`).length > 0);
  assert.ok(scanSecrets(fakePasswordAssignment).length > 0);
  assert.ok(scanSecrets(fakeGithubToken).length > 0);
  assert.ok(scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").length > 0);
});

test("scanSecrets findings carry a masked excerpt only", () => {
  const findings = scanSecrets(fakeApiKeyAssignment);
  assert.ok(findings.length > 0);
  assert.ok(!findings[0]!.excerpt.includes("supersecretvalue123"));
});

test("enforceWritePrivacy always redacts <private> spans", () => {
  assert.equal(enforceWritePrivacy("clean <private>x</private>"), "clean [REDACTED]");
});

test("enforceWritePrivacy secret gate is OFF by default (privacy via prompt)", () => {
  // Default: a surviving secret is written as-is after <private> redaction.
  assert.equal(
    enforceWritePrivacy(`my ${fakePasswordAssignment}`),
    `my ${fakePasswordAssignment}`,
  );
});

test("enforceWritePrivacy refuses hard secrets only when the gate is enabled", () => {
  assert.throws(
    () => enforceWritePrivacy(`my ${fakePasswordAssignment}`, { refuseSecrets: true }),
    (err: unknown) => err instanceof SecretRefusedError,
  );
});
