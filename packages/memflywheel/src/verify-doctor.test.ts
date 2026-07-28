import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { WIRING_KEY, buildWiringMarker, writeHostConfig } from "./adapter.js";
import { piAdapter } from "./pi.js";
import { hermesAdapter } from "./hermes.js";
import { tempDir } from "./test-helpers.js";

test("verify fails when nothing is installed", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  const v = await piAdapter.verify({ configPath });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /does not exist/);
});

test("verify succeeds after a real apply (round-trips from disk)", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await piAdapter.install({ configPath }, { apply: true });
  const v = await piAdapter.verify({ configPath });
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.problems.length, 0);
});

test("verify re-reads disk — a post-apply tamper is caught", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await piAdapter.install({ configPath }, { apply: true });

  // Corrupt the bindings on disk after install.
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  raw[WIRING_KEY].bindings = [];
  await writeFile(configPath, JSON.stringify(raw), "utf8");

  const v = await piAdapter.verify({ configPath });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /do not match/);
});

test("verify rejects a config wired for a different adapter", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  // Install hermes wiring, then verify with pi.
  await hermesAdapter.install({ configPath }, { apply: true });
  const v = await piAdapter.verify({ configPath });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /belongs to adapter "hermes"/);
});

test("verify reports corrupt config", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await writeFile(configPath, "}}}", "utf8");
  const v = await piAdapter.verify({ configPath });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /corrupt/);
});

test("doctor: not-installed, ok, and stale states", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");

  let findings = await piAdapter.doctor({ configPath });
  assert.equal(findings[0]?.code, "not-installed");

  await piAdapter.install({ configPath }, { apply: true });
  findings = await piAdapter.doctor({ configPath });
  assert.equal(findings[0]?.code, "ok");

  // Make it stale by downgrading version on disk.
  const stale = buildWiringMarker(piAdapter);
  stale.version = 0;
  await writeHostConfig(configPath, { [WIRING_KEY]: stale });
  findings = await piAdapter.doctor({ configPath });
  assert.equal(findings[0]?.code, "stale-wiring");
});

test("doctor reports corrupt config", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await writeFile(configPath, "nope", "utf8");
  const findings = await piAdapter.doctor({ configPath });
  assert.equal(findings[0]?.code, "corrupt-config");
});

test("writeHostConfig is atomic JSON round-trip with trailing newline", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "deep", "host.json");
  await writeHostConfig(configPath, { a: 1, [WIRING_KEY]: { x: true } });
  const raw = await readFile(configPath, "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.deepEqual(JSON.parse(raw), { a: 1, [WIRING_KEY]: { x: true } });
});
