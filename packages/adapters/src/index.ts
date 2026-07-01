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

// Host harness port: stable host boundary + capability gates.
export {
  type HostCapability,
  type HostIntegrationMode,
  type Dispose,
  type HostPromptBuildEvent,
  type HostPromptBuildResult,
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
  type PiModelContext,
  type PiModelAuthResult,
  type PiExtensionContextLike,
  type PiExtensionHandler,
  type PiExtensionApiLike,
  type PiCompleteSimple,
  type PiSessionIdResolver,
  type CreatePiModelCompletionOptions,
  type CreatePiHarnessPortOptions,
  type PiScribeLike,
  canonicalMessagesFromPi,
  memScribeMessagesFromPi,
  buildPiPromptInjection,
  createPiModelCompletion,
  attachPiScribe,
  createPiHarnessPort,
} from "./pi-port.js";

export {
  type OpenCodeClientLike,
  type OpenCodePluginInput,
  type OpenCodeHarnessPortOptions,
  type OpenCodeHooks,
  defaultOpenCodeMemFlywheelRoot,
  canonicalMessagesFromOpenCodeSessionMessages,
  createOpenCodeHarnessPort,
  createOpenCodePluginServer,
  createOpenCodePluginServer as server,
} from "./opencode-port.js";

export {
  type OpenClawApiLike,
  type OpenClawHarnessPortOptions,
  defaultOpenClawMemFlywheelRoot,
  canonicalMessagesFromOpenClawMessages,
  createOpenClawHarnessPort,
  registerOpenClawMemoryCapability,
  createOpenClawPluginRuntime,
} from "./openclaw-port.js";

export {
  type EnvLike,
  type OpenAICompatibleEnvModelOptions,
  type ResolvedOpenAICompatibleEnvModelConfig,
  resolveOpenAICompatibleEnvModelConfig,
  createOpenAICompatibleEnvModel,
} from "./openai-env-model.js";

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
  type CanonicalModelCompletion,
  canonicalMessagesToMemFlywheelMessages,
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
