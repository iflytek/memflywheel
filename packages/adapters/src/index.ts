/**
 * @iflytekopensource/adapters — host lifecycle mappings.
 *
 * Each adapter maps a host's lifecycle events (session start, prompt build,
 * turn end, idle/scheduled) onto a MemFlywheel's hooks. Adapters contain NO
 * memory logic — pure event translation plus a real, round-trippable install
 * of the host-side wiring.
 *
 * Install always plans first (plan/apply); verify performs a real round-trip by
 * re-reading the host config from disk — it never reports success from a write.
 */

// Framework: contracts, install/verify/doctor, lifecycle binding.
export {
  // Adapter-facing contract (structural mirror of @memflywheel/sdk MemFlywheel)
  type MemFlywheelMessage,
  type MemFlywheelContext,
  type MemFlywheel,
  type HostRuntime,
  // Lifecycle mapping
  type MemFlywheelHook,
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
export { type AdapterSpec, makeAdapter, readString, normalizeMessages } from "./make-adapter.js";

// Hermes installs its bridge worker outside the pnpm workspace. Re-export the
// pi-ai stream primitive through this already-resolved adapter entrypoint so
// the installed worker has one dependency boundary instead of reaching back
// into workspace node_modules by package name.
export { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Host harness port: stable host boundary + capability gates.
export {
  type HostCapability,
  type HostIntegrationMode,
  type Dispose,
  type HostPromptBuildEvent,
  type HostPromptBuildResult,
  type HostToolCall,
  type HostMessage,
  type HostTurnEndEvent,
  type HostSessionEvent,
  type HostIdleEvent,
  type HostLifecyclePort,
  type HostToolCallEvent,
  type HostToolResultEvent,
  type HostTelemetryPort,
  type HostHarnessPort,
  classifyHostCapabilities,
  requireHostCapabilities,
  createCapabilitySet,
} from "./harness-port.js";

// Pi native port: Pi model/lifecycle/telemetry -> HostHarnessPort.
export {
  type PiTextContent,
  type PiImageContent,
  type PiToolCallContent,
  type PiUserMessage,
  type PiToolResultMessage,
  type PiAssistantMessage,
  type PiAgentMessage,
  type PiModelAuthResult,
  type PiExtensionContextLike,
  type PiExtensionHandler,
  type PiExtensionApiLike,
  type PiStreamSimple,
  type PiSessionIdResolver,
  type CreatePiAgentModelResolverOptions,
  type CreatePiHarnessPortOptions,
  type PiScribeLike,
  hostMessagesFromPi,
  memScribeMessagesFromPi,
  buildPiPromptInjection,
  createPiAgentModelResolver,
  attachPiScribe,
  createPiHarnessPort,
} from "./pi-port.js";

export {
  type OpenCodeClientLike,
  type OpenCodePluginInput,
  type OpenCodeHarnessPortOptions,
  type OpenCodeHooks,
  defaultOpenCodeMemFlywheelRoot,
  configureOpenCodeMemoryPermission,
  hostMessagesFromOpenCodeSessionMessages,
  createOpenCodeHostModel,
  createOpenCodeHarnessPort,
  createOpenCodePluginServer,
  createOpenCodePluginServer as server,
} from "./opencode-port.js";

export {
  type OpenClawNativeModelSelection,
  type OpenClawNativeModelRuntime,
  createOpenClawHostModel,
} from "./openclaw-native-model.js";

export {
  type OpenClawApiLike,
  type OpenClawHarnessPortOptions,
  defaultOpenClawMemFlywheelRoot,
  hostMessagesFromOpenClawMessages,
  createOpenClawHarnessPort,
  registerOpenClawMemoryCapability,
  registerOpenClawSingleWriterGuard,
  openClawHostMemoryPaths,
  createOpenClawPluginRuntime,
} from "./openclaw-port.js";

// Host-scribe bridge: wrap a canonical host model into a batteries-included scribe.
export {
  type HostLearnedSkillEvolutionInput,
  type HostLearnedSkillsOptions,
  type MemFlywheelHarnessMode,
  type MemFlywheelHarnessRuntimeOptions,
  type MemFlywheelHarnessRuntimeAdapter,
  type MemFlywheelHarnessRuntime,
  type MemFlywheelLearningLoopConfig,
  type MemoryIndexRetrievalOptions,
  type SkillPreludeBuilder,
  type SkillRecallProvider,
  type ResolvePiAgentModel,
  hostMessagesToMemFlywheelMessages,
  attachMemFlywheelToHostPort,
  createMemFlywheelHarnessRuntime,
  adaptSdkMemFlywheel,
} from "./host-memflywheel.js";

// Built-in host adapters.
export { piAdapter } from "./pi.js";
export { hermesAdapter } from "./hermes.js";
export { opencodeAdapter } from "./opencode.js";
export { openclawAdapter } from "./openclaw.js";

// Registry.
export { ADAPTERS, getAdapter, adapterIds } from "./registry.js";
