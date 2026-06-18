import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type InstallPlan,
  type InstallResult,
  WIRING_KEY,
  WIRING_VERSION,
  buildWiringMarker,
  readWiringMarker,
} from "./adapter.js";
import { piAdapter } from "./pi.js";
import { tempDir } from "./test-helpers.js";

function asPlan(r: InstallPlan | InstallResult): InstallPlan {
  assert.ok("steps" in r && "satisfied" in r, "expected an InstallPlan");
  return r as InstallPlan;
}

test("install plan on a fresh dir proposes create-config and is not satisfied", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  const plan = asPlan(await piAdapter.install({ configPath }));
  assert.equal(plan.adapterId, "pi");
  assert.equal(plan.satisfied, false);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.kind, "create-config");
});

test("plan does NOT write anything to disk", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await piAdapter.install({ configPath });
  await assert.rejects(readFile(configPath, "utf8"), /ENOENT/);
});

test("apply creates the config and writes a correct wiring marker", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  const result = (await piAdapter.install({ configPath }, { apply: true })) as InstallResult;
  assert.equal(result.adapterId, "pi");
  assert.ok(result.applied.length >= 1);

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const marker = readWiringMarker(raw);
  assert.ok(marker, "marker present");
  assert.equal(marker!.version, WIRING_VERSION);
  assert.equal(marker!.adapter, "pi");
  // One binding per scribe hook.
  assert.equal(marker!.bindings.length, 4);
  assert.deepEqual(
    marker!.bindings.map((b) => b.hook).sort(),
    ["onIdle", "onPromptBuild", "onSessionStart", "onTurnEnd"],
  );
});

test("apply preserves unrelated keys in the host config", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await writeFile(configPath, JSON.stringify({ model: "gpt", nested: { a: 1 } }), "utf8");

  await piAdapter.install({ configPath }, { apply: true });
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(raw.model, "gpt");
  assert.deepEqual(raw.nested, { a: 1 });
  assert.ok(raw[WIRING_KEY], "wiring added alongside existing keys");
});

test("plan after a successful apply is satisfied with a noop", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await piAdapter.install({ configPath }, { apply: true });
  const plan = asPlan(await piAdapter.install({ configPath }));
  assert.equal(plan.satisfied, true);
  assert.equal(plan.steps[0]?.kind, "noop");
});

test("apply is idempotent — second apply changes nothing", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await piAdapter.install({ configPath }, { apply: true });
  const before = await readFile(configPath, "utf8");
  const second = (await piAdapter.install({ configPath }, { apply: true })) as InstallResult;
  assert.equal(second.applied.length, 0);
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("stale wiring (older version) plans an update", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  const stale = buildWiringMarker(piAdapter);
  stale.version = WIRING_VERSION - 1;
  await writeFile(configPath, JSON.stringify({ [WIRING_KEY]: stale }), "utf8");

  const plan = asPlan(await piAdapter.install({ configPath }));
  assert.equal(plan.satisfied, false);
  assert.equal(plan.steps[0]?.kind, "update-wiring");

  await piAdapter.install({ configPath }, { apply: true });
  const fixed = readWiringMarker(JSON.parse(await readFile(configPath, "utf8")));
  assert.equal(fixed!.version, WIRING_VERSION);
});

test("corrupt config plans a rewrite and apply overwrites it cleanly", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "host.json");
  await writeFile(configPath, "{ not json", "utf8");

  const plan = asPlan(await piAdapter.install({ configPath }));
  assert.equal(plan.satisfied, false);
  assert.equal(plan.steps[0]?.kind, "update-wiring");

  await piAdapter.install({ configPath }, { apply: true });
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.ok(readWiringMarker(raw), "marker written over corrupt file");
});
