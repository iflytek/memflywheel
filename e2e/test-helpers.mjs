/**
 * Core test utilities for K8s E2E memory-lifecycle tests.
 *
 * Exports:
 *   check, printSummary      — result tracking
 *   kubectl, kubectlExec     — K8s command wrappers
 *   waitForPodReady          — pod readiness wait
 *   findMemoryFile           — search MEMORY.md in candidate paths
 *   assertMemoryContent      — regex assertion on memory content
 *   scanMemoryDirs           — scan dirs for MEMORY.md
 *   runCase                  — run a single test case for an agent
 */

import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";

// ─── result tracker ────────────────────────────────────────────────────────

const results = [];

export function check(name, cond, detail = "") {
  const status = cond ? "pass" : "fail";
  results.push({ name, status, detail });
  const mark = cond ? "✅" : "❌";
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}

export function printSummary() {
  console.log("\n── summary");
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(`  pass: ${passed}  fail: ${failed}  total: ${results.length}`);
  if (failed > 0) {
    console.error(`\n❌ ${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\n✅ ALL PASSED");
}

// ─── kubectl helpers ───────────────────────────────────────────────────────

export function kubectl(...args) {
  return execFileSync("kubectl", args, { encoding: "utf8" }).trim();
}

export function kubectlExec(namespace, pod, ...cmd) {
  return kubectl("exec", "-n", namespace, `pod/${pod}`, "--", ...cmd);
}

// ─── pod readiness ─────────────────────────────────────────────────────────

export async function waitForPodReady(namespace, pod, timeoutSec = 120) {
  console.log(`── waiting for ${pod} in ${namespace}`);
  try {
    kubectl(
      "wait",
      "--for=condition=Ready",
      "-n",
      namespace,
      `pod/${pod}`,
      `--timeout=${timeoutSec}s`,
    );
    check("pod ready", true, `${pod} in ${namespace}`);
    return true;
  } catch {
    check("pod ready", false, `${pod} not ready after ${timeoutSec}s`);
    return false;
  }
}

// ─── memory file helpers ───────────────────────────────────────────────────

export function findMemoryFile(namespace, pod, paths) {
  for (const p of paths) {
    try {
      const content = kubectlExec(namespace, pod, "cat", p);
      if (content) {
        console.log(`  Found MEMORY.md at ${p}`);
        return content;
      }
    } catch {
      /* try next */
    }
  }
  return "";
}

export function assertMemoryContent(memoryMd, patterns) {
  for (const { label, regex } of patterns) {
    const found = regex.test(memoryMd);
    check(label, found, found ? "" : memoryMd.slice(0, 200));
  }
}

export function scanMemoryDirs(namespace, pod, dirs) {
  for (const dir of dirs) {
    try {
      const listing = kubectlExec(namespace, pod, "ls", "-R", dir);
      if (listing.includes("MEMORY.md")) {
        console.log(`  Memory files found under ${dir}`);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

// ─── mock-llm config push ──────────────────────────────────────────────────

/**
 * Push case config (chat responses + extraction rules) to mock-llm.
 * Writes a JSON file into the mock-llm pod via base64-encoded kubectl exec.
 *
 * Chat matchers are derived from extraction rules (same keyword patterns).
 */
export function pushCaseConfig(testCase) {
  const config = {
    chat: testCase.prompts.map((p, i) => {
      const extRule = (testCase.extraction ?? [])[i];
      return {
        match: extRule?.match ?? p.text.split(/\s+/).slice(0, 3).join("|"),
        response: p.chatResponse,
      };
    }),
    extraction: testCase.extraction ?? [],
  };

  const b64 = Buffer.from(JSON.stringify(config)).toString("base64");
  const pod = kubectl(
    "get",
    "pod",
    "-n",
    "default",
    "-l",
    "app=mock-llm",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  );
  kubectl(
    "exec",
    "-n",
    "default",
    `pod/${pod}`,
    "--",
    "sh",
    "-c",
    `echo '${b64}' | base64 -d > /tmp/case-config.json`,
  );
}

// ─── case runner ───────────────────────────────────────────────────────────

/**
 * Run a single test case for an agent:
 *   1. Send conversation prompts
 *   2. Run afterTurns hook (if any)
 *   3. Read MEMORY.md and assert content
 *   4. Scan memory dirs
 */
export async function runCase(agent, testCase) {
  // 1. Conversation turns
  for (let i = 0; i < testCase.prompts.length; i++) {
    const { text, waitMs } = testCase.prompts[i];
    console.log(`  turn ${i + 1}: ${text.slice(0, 60)}...`);
    try {
      const output = agent.chatFn(text);
      check(`turn ${i + 1} completed`, true, output?.slice(0, 100));
    } catch (e) {
      check(`turn ${i + 1} completed`, false, e.message?.slice(0, 200));
    }
    await delay(waitMs);
  }

  // 2. Post-conversation hook
  if (agent.afterTurns) {
    await agent.afterTurns(testCase);
  }

  // 3. Read and assert memory
  const memoryMd = findMemoryFile(agent.namespace, agent.sandbox, agent.memoryPaths);
  check("MEMORY.md exists", memoryMd.length > 0, memoryMd ? `${memoryMd.length} bytes` : "empty");
  if (memoryMd) {
    assertMemoryContent(memoryMd, testCase.assertions);
  }

  // 4. Directory scan
  const foundDirs = scanMemoryDirs(agent.namespace, agent.sandbox, agent.memoryDirs);
  check("memory directory has files", foundDirs);
}
