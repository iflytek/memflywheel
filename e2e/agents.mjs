/**
 * Agent configuration for E2E tests.
 *
 * Each agent is a config object with:
 *   - name, namespace, sandbox  — K8s identity
 *   - chatFn(prompt)            — sends a prompt to the agent
 *   - waitForSetup?()           — async hook for runtime setup (e.g. plugin install)
 *   - verifySetup()             — sync hook to verify installation
 *   - afterTurns?()             — async hook after all conversation turns
 *   - memoryPaths               — candidate paths for MEMORY.md
 *   - memoryDirs                — directories to scan for memory files
 *   - debugDir                  — optional dir for debug file listing
 *
 * Adding a new agent: append a config object to AGENTS.
 */

import { setTimeout as delay } from "node:timers/promises";
import { check, kubectlExec } from "./test-helpers.mjs";

// ─── Hermes ────────────────────────────────────────────────────────────────

const HERMES_NS = "hermes-test";
const HERMES_POD = "hermes-agent";
const HERMES_HOME = "/opt/data";
const PLUGIN_DIR = `${HERMES_HOME}/plugins/memflywheel`;

function hermesChat(prompt) {
  return kubectlExec(
    HERMES_NS,
    HERMES_POD,
    "bash",
    "-c",
    'hermes chat -q "$1" -Q --yolo',
    "_",
    prompt,
  );
}

async function hermesWaitForSetup() {
  let installed = false;
  for (let i = 0; i < 30; i++) {
    try {
      const listing = kubectlExec(HERMES_NS, HERMES_POD, "ls", PLUGIN_DIR);
      if (listing.includes("__init__.py") && listing.includes("worker.mjs")) {
        installed = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await delay(2000);
  }
  check("memflywheel plugin installed", installed, installed ? "files present" : "timed out");
  if (!installed) process.exit(1);
}

function hermesVerifySetup() {
  try {
    const version = kubectlExec(HERMES_NS, HERMES_POD, "hermes", "version");
    check("hermes binary available", Boolean(version), version?.slice(0, 50));
  } catch (e) {
    check("hermes binary available", false, e.message?.slice(0, 100));
  }
  try {
    const files = kubectlExec(HERMES_NS, HERMES_POD, "ls", "-la", PLUGIN_DIR);
    check("plugin __init__.py present", files.includes("__init__.py"));
    check("plugin worker.mjs present", files.includes("worker.mjs"));
    check("plugin install.json present", files.includes("install.json"));
  } catch {
    check("plugin __init__.py present", false, "plugin directory not found");
    check("plugin worker.mjs present", false);
    check("plugin install.json present", false);
  }
  try {
    const config = kubectlExec(HERMES_NS, HERMES_POD, "cat", `${HERMES_HOME}/config.yaml`);
    check("memory.provider configured", /provider:\s*memflywheel/m.test(config), "memflywheel");
  } catch {
    check("memory.provider configured", false, "config.yaml not found");
  }
}

// ─── Pi ────────────────────────────────────────────────────────────────────

const PI_NS = "pi-test";
const PI_POD = "pi-agent";

function piChat(prompt) {
  return kubectlExec(
    PI_NS,
    PI_POD,
    "pi",
    "--provider",
    "openai",
    "--model",
    "mock-llm",
    "--print",
    "-e",
    "/root/.pi/agent/extensions/memflywheel/index.mjs",
    prompt,
  );
}

function piVerifySetup() {
  try {
    const version = kubectlExec(PI_NS, PI_POD, "pi", "--version");
    check("pi binary available", Boolean(version), version?.slice(0, 50));
  } catch (e) {
    check("pi binary available", false, e.message?.slice(0, 100));
  }
  try {
    const extList = kubectlExec(
      PI_NS,
      PI_POD,
      "ls",
      "-la",
      "/root/.pi/agent/extensions/memflywheel/",
    );
    check("memflywheel extension installed", extList.includes("index.mjs"));
  } catch {
    check("memflywheel extension installed", false, "extension directory not found");
  }
  try {
    const settings = kubectlExec(PI_NS, PI_POD, "cat", "/root/.pi/agent/settings.json");
    const parsed = JSON.parse(settings);
    const hasExt = parsed.pi?.extensions?.some((e) => e.includes("memflywheel"));
    check("extension in settings.json", hasExt, JSON.stringify(parsed.pi?.extensions));
  } catch (e) {
    check("extension in settings.json", false, e.message?.slice(0, 100));
  }
}

async function piAfterTurns(testCase) {
  const prompts = testCase.prompts.map((p) => p.text);
  kubectlExec(PI_NS, PI_POD, "node", "/e2e/pi/extract.mjs", "/workspace", ...prompts);
  await delay(2000);
}

// ─── exports ───────────────────────────────────────────────────────────────

export const AGENTS = [
  {
    name: "Hermes",
    namespace: HERMES_NS,
    sandbox: HERMES_POD,
    chatFn: hermesChat,
    waitForSetup: hermesWaitForSetup,
    verifySetup: hermesVerifySetup,
    afterTurns: null,
    memoryPaths: [`${HERMES_HOME}/memflywheel/MEMORY.md`, `${HERMES_HOME}/memories/MEMORY.md`],
    memoryDirs: [`${HERMES_HOME}/memflywheel`, `${HERMES_HOME}/memories`],
    debugDir: `${HERMES_HOME}/memflywheel`,
  },
  {
    name: "Pi",
    namespace: PI_NS,
    sandbox: PI_POD,
    chatFn: piChat,
    waitForSetup: null,
    verifySetup: piVerifySetup,
    afterTurns: piAfterTurns,
    memoryPaths: [
      "/root/.memflywheel/MEMORY.md",
      "/workspace/MEMORY.md",
      "/root/.pi/agent/memflywheel/MEMORY.md",
    ],
    memoryDirs: ["/root/.memflywheel", "/workspace", "/root/.pi/agent/memflywheel"],
    debugDir: "/workspace",
  },
];
