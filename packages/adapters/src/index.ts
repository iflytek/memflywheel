/**
 * @memscribe/adapters — host lifecycle mappings.
 *
 * Each adapter maps a host's lifecycle events (session start, prompt build,
 * turn end, idle/scheduled) onto a MemScribe's hooks. Adapters contain NO
 * memory logic — pure event translation plus a real, round-trippable install
 * of the host-side wiring.
 *
 * Install always plans first (plan/apply); verify performs a real round-trip by
 * re-reading the host config from disk — it never reports success from a write.
 */

// Framework: contracts, install/verify/doctor, lifecycle binding.
export {
  // Adapter-facing contract (structural mirror of @memscribe/sdk MemScribe)
  type MemScribeMessage,
  type MemScribeContext,
  type MemScribe,
  type HostRuntime,
  // Lifecycle mapping
  type MemScribeHook,
  type LifecycleMapping,
  type LifecycleMap,
  type HookTranslators,
  bindLifecycle,
  // Install / verify / doctor
  type InstallTarget,
  type InstallStep,
  type InstallPlan,
  type InstallResult,
  type VerifyResult,
  type DoctorFinding,
  type HostAdapter,
  type ConnectResult,
  planInstall,
  applyInstall,
  verifyInstall,
  doctorInstall,
  resolveInstallTarget,
  connect,
  // Wiring marker + config I/O
  type WiringMarker,
  WIRING_VERSION,
  WIRING_KEY,
  buildWiringMarker,
  markersEqual,
  readHostConfig,
  writeHostConfig,
  readWiringMarker,
} from "./adapter.js";

// Factory + translator helpers (for building custom adapters).
export {
  type AdapterSpec,
  makeAdapter,
  readString,
  normalizeMessages,
} from "./make-adapter.js";

// Host-scribe bridge: wrap a host LLM channel into a batteries-included scribe.
export {
  type ToolCompletion,
  type HostLearnedSkillEvolutionInput,
  type HostLearnedSkillsOptions,
  type HostMemScribeOptions,
  type HostMemScribeAdapter,
  type HostMemScribe,
  type MemScribeLearningLoopConfig,
  type SkillPreludeBuilder,
  type SkillRecallProvider,
  type SkillUsageRecord,
  createHostMemScribe,
  adaptSdkMemScribe,
} from "./host-memscribe.js";

// Built-in host adapters.
export { piAdapter } from "./pi.js";
export { hermesAdapter } from "./hermes.js";
export { opencodeAdapter } from "./opencode.js";
export { openclawAdapter } from "./openclaw.js";
export { codexAdapter } from "./codex.js";
export { claudeCodeAdapter } from "./claude-code.js";

// Registry.
export { ADAPTERS, getAdapter, adapterIds } from "./registry.js";
