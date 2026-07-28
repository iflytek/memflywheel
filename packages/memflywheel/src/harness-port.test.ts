import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyHostCapabilities,
  requireHostCapabilities,
  type HostCapability,
} from "./harness-port.js";

function caps(values: HostCapability[]): ReadonlySet<HostCapability> {
  return new Set(values);
}

test("classifyHostCapabilities distinguishes recall, memory loop, and full skill loop", () => {
  assert.equal(classifyHostCapabilities(caps(["prompt-build"])), "recall-only");
  assert.equal(
    classifyHostCapabilities(caps(["prompt-build", "turn-end", "agentic-tool-loop"])),
    "memory-loop",
  );
  assert.equal(
    classifyHostCapabilities(
      caps(["prompt-build", "turn-end", "agentic-tool-loop", "tool-trajectory"]),
    ),
    "skill-loop",
  );
});

test("requireHostCapabilities reports missing gates without host-name coupling", () => {
  assert.throws(
    () => requireHostCapabilities("future-agent", caps(["prompt-build"]), ["agentic-tool-loop"]),
    /future-agent missing host capabilities: agentic-tool-loop/,
  );
});
