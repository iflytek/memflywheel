import type {
  CanonicalModelCompletion,
  CanonicalModelMessage,
} from "@memscribe/model";

export type HostCapability =
  | "prompt-build"
  | "turn-end"
  | "session-end"
  | "idle"
  | "single-tool-completion"
  | "agentic-tool-loop"
  | "tool-trajectory";

export type HostIntegrationMode = "none" | "recall-only" | "memory-loop" | "skill-loop";

export type Dispose = () => void;

export interface HostPromptBuildEvent {
  sessionId?: string;
}

export interface HostPromptBuildResult {
  systemPrompt?: string;
  preludePrompt?: string;
  skillPreludePrompt?: string;
}

export interface HostTurnEndEvent {
  sessionId: string;
  messages: CanonicalModelMessage[];
}

export interface HostSessionEvent {
  sessionId: string;
}

export interface HostIdleEvent {
  force?: boolean;
}

export interface HostLifecyclePort {
  onPromptBuild(handler: (event: HostPromptBuildEvent) => Promise<HostPromptBuildResult>): Dispose;
  onTurnEnd(handler: (event: HostTurnEndEvent) => Promise<void>): Dispose;
  onSessionEnd(handler: (event: HostSessionEvent) => Promise<void>): Dispose;
  onIdle?(handler: (event?: HostIdleEvent) => Promise<void>): Dispose;
}

export interface HostToolCallEvent {
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface HostToolResultEvent extends HostToolCallEvent {
  output: unknown;
  isError?: boolean;
}

export interface HostTelemetryPort {
  onToolCall?(handler: (event: HostToolCallEvent) => Promise<void>): Dispose;
  onToolResult?(handler: (event: HostToolResultEvent) => Promise<void>): Dispose;
}

export interface HostHarnessPort {
  readonly name: string;
  readonly capabilities: ReadonlySet<HostCapability>;
  readonly lifecycle: HostLifecyclePort;
  readonly model: CanonicalModelCompletion;
  readonly telemetry?: HostTelemetryPort;
}

function hasAll(
  capabilities: ReadonlySet<HostCapability>,
  required: readonly HostCapability[],
): boolean {
  return required.every((capability) => capabilities.has(capability));
}

export function classifyHostCapabilities(
  capabilities: ReadonlySet<HostCapability>,
): HostIntegrationMode {
  if (hasAll(capabilities, ["prompt-build", "turn-end", "agentic-tool-loop", "tool-trajectory"])) {
    return "skill-loop";
  }
  if (hasAll(capabilities, ["prompt-build", "turn-end", "agentic-tool-loop"])) {
    return "memory-loop";
  }
  if (capabilities.has("prompt-build")) {
    return "recall-only";
  }
  return "none";
}

export function requireHostCapabilities(
  hostName: string,
  capabilities: ReadonlySet<HostCapability>,
  required: readonly HostCapability[],
): void {
  const missing = required.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(`${hostName} missing host capabilities: ${missing.join(", ")}`);
  }
}

export function createCapabilitySet(
  capabilities: readonly HostCapability[],
): ReadonlySet<HostCapability> {
  return new Set(capabilities);
}
