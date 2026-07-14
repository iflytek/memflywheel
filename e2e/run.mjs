/**
 * Unified E2E test runner — runs all agents × all cases.
 *
 * Usage: node e2e/run.mjs
 *
 * Prerequisites:
 *   - kind cluster running with agent-sandbox CRDs
 *   - Agent Sandboxes deployed (hermes-agent, pi-agent)
 *   - mock-llm service running in default namespace
 */

import { AGENTS } from "./agents.mjs";
import { CASES } from "./cases.mjs";
import {
  waitForPodReady,
  runCase,
  pushCaseConfig,
  kubectlExec,
  printSummary,
} from "./test-helpers.mjs";

for (const agent of AGENTS) {
  console.log(`\n🧪 ${agent.name} K8s E2E\n`);

  // 1. Wait for pod
  const ready = await waitForPodReady(agent.namespace, agent.sandbox);
  if (!ready) continue;

  // 2. Agent-specific setup wait
  if (agent.waitForSetup) {
    console.log(`\n── waiting for ${agent.name} setup`);
    await agent.waitForSetup();
  }

  // 3. Agent-specific verification
  if (agent.verifySetup) {
    console.log(`\n── verifying ${agent.name} installation`);
    agent.verifySetup();
  }

  // 4. Run each test case
  for (const tc of CASES) {
    console.log(`\n── case: ${tc.name}`);
    pushCaseConfig(tc);
    console.log(`  config pushed to mock-llm`);
    await runCase(agent, tc);
  }

  // 5. Debug listing
  if (agent.debugDir) {
    try {
      console.log(`\n── debug: files under ${agent.debugDir}`);
      const listing = kubectlExec(
        agent.namespace,
        agent.sandbox,
        "find",
        agent.debugDir,
        "-type",
        "f",
      );
      console.log(listing || "  (empty)");
    } catch {
      console.log("  (dir not found)");
    }
  }
}

printSummary();
