import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  type ConnectResult,
  type InstallResult,
  connect,
  readWiringMarker,
  resolveInstallTarget,
} from "./adapter.js";
import { piAdapter } from "./pi.js";
import { hermesAdapter } from "./hermes.js";
import { openclawAdapter } from "./openclaw.js";
import { tempDir } from "./test-helpers.js";

test("resolveInstallTarget prefers an explicit configPath", () => {
  const t = resolveInstallTarget(piAdapter, "/tmp/x.json");
  assert.equal(t.configPath, "/tmp/x.json");
});

test("resolveInstallTarget falls back to the adapter's default under home", () => {
  const t = resolveInstallTarget(piAdapter);
  assert.equal(t.configPath, path.join(homedir(), ".pi/agent/settings.json"));
});

test("every real-integration adapter declares a default config path", () => {
  assert.ok(piAdapter.defaultConfigRelPath);
  assert.ok(hermesAdapter.defaultConfigRelPath);
  assert.ok(openclawAdapter.defaultConfigRelPath);
});

test("openclaw carries an explicit recall-only integration note", () => {
  assert.match(openclawAdapter.integrationNote ?? "", /recall/i);
  assert.match(openclawAdapter.integrationNote ?? "", /HostHarnessPort/i);
  assert.doesNotMatch(openclawAdapter.integrationNote ?? "", /best-effort/i);
});

test("connect plan-only does not write and is not verified", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  const res = await connect(piAdapter, { configPath });
  assert.equal(res.adapterId, "pi");
  assert.equal(res.verify, undefined);
  assert.ok("steps" in res.install);
  await assert.rejects(readFile(configPath, "utf8"), /ENOENT/);
});

test("connect apply writes the wiring and round-trip verifies from disk", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  const res: ConnectResult = await connect(piAdapter, { configPath, apply: true });
  assert.ok(res.verify, "verify present on apply");
  assert.equal(res.verify!.ok, true, res.verify!.problems.join("; "));

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const marker = readWiringMarker(raw);
  assert.ok(marker);
  assert.equal(marker!.adapter, "pi");
  assert.equal((res.install as InstallResult).applied.length >= 1, true);
});

test("connect apply is idempotent (second connect verifies, applies nothing)", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await connect(piAdapter, { configPath, apply: true });
  const before = await readFile(configPath, "utf8");
  const second = await connect(piAdapter, { configPath, apply: true });
  assert.equal(second.verify!.ok, true);
  assert.equal((second.install as InstallResult).applied.length, 0);
  assert.equal(await readFile(configPath, "utf8"), before);
});
