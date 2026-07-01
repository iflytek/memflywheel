import { join } from "node:path";

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "../dist/index.js";
import { resolveMemFlywheelRoot, resolvePiAgentDir, syncLearnedSkillsToPi } from "./sync.mjs";

export default function memFlywheelExtension(pi) {
  const piAgentDir = resolvePiAgentDir();
  const root = resolveMemFlywheelRoot(piAgentDir);
  const syncSkills = () => syncLearnedSkillsToPi({ root, piAgentDir });
  const port = createPiHarnessPort(pi, {
    completeSimple,
    afterPromptBuild: syncSkills,
    afterTurnEnd: syncSkills,
    afterSessionEnd: syncSkills,
  });
  const runtime = createMemFlywheelHarnessRuntime({
    port,
    root,
    learnedSkills: { skillsRoot: join(root, "learned-skills") },
  });

  syncSkills();

  if (typeof pi.onDispose === "function") pi.onDispose(runtime.dispose);
  return runtime.dispose;
}
