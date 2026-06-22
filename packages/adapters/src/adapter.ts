/**
 * Shared host-adapter framework.
 *
 * An adapter maps a host's lifecycle events onto a MemScribe's hooks. Adapters
 * contain NO memory logic — they are pure event translation plus a real,
 * round-trippable install of the host-side wiring.
 *
 * The scribe contract below is structurally identical to @memscribe/sdk's
 * `MemScribe`. It is declared here (not imported) so adapters build and test
 * independently of the SDK package: any object with these methods — including a
 * real `createMemScribe(...)` — satisfies `MemScribe` structurally.
 */

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Adapter-facing contract (structural mirror of @memscribe/sdk MemScribe)
// ---------------------------------------------------------------------------

/** One host tool call folded into a turn (structural mirror of core's ExtractionToolCall). */
export interface MemScribeToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
}

/** A turn message in the shape core extraction expects. */
export interface MemScribeMessage {
  role: "user" | "assistant";
  text: string;
  /** Host tool calls made on this turn, folded into extraction as truncated text. */
  toolCalls?: MemScribeToolCall[];
}

/** The two recall segments core produces. */
export interface MemScribeContext {
  /** STABLE memory rules — host merges into its systemPrompt (cache-friendly). */
  systemPrompt: string;
  /** DYNAMIC full-index prelude, wrapped in <system-reminder>, injected per turn. */
  preludePrompt: string;
  /** Optional learned-skill prelude appended by the SDK when skill recall is configured. */
  skillPreludePrompt?: string;
  enabled: boolean;
}

/**
 * The lifecycle surface an adapter drives. Structurally compatible with the
 * SDK's `MemScribe`; only the hooks adapters actually call are required.
 */
export interface MemScribe {
  onSessionStart(input: { sessionId: string }): Promise<void>;
  onPromptBuild(input: { sessionId: string }): Promise<MemScribeContext>;
  onTurnEnd(input: { sessionId: string; messages: MemScribeMessage[] }): Promise<unknown>;
  onSessionEnd(input: { sessionId: string }): Promise<void>;
  onIdle(input?: { force?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Lifecycle mapping
// ---------------------------------------------------------------------------

/** The canonical scribe hooks a host event can map to. */
export type MemScribeHook =
  | "onSessionStart"
  | "onPromptBuild"
  | "onTurnEnd"
  | "onSessionEnd"
  | "onIdle";

/** One host-event → scribe-hook mapping row (documentation + verification data). */
export interface LifecycleMapping {
  /** The scribe hook this host event drives. */
  hook: MemScribeHook;
  /** The host's native event/callback name. */
  hostEvent: string;
  /** Human description of what the adapter does at this point. */
  note: string;
}

/** A host adapter's lifecycle map keyed by scribe hook. */
export type LifecycleMap = Readonly<Partial<Record<MemScribeHook, LifecycleMapping>>>;

// ---------------------------------------------------------------------------
// Install: plan / apply / verify / doctor
// ---------------------------------------------------------------------------

/** Where the host keeps the config the adapter installs its wiring into. */
export interface InstallTarget {
  /** Absolute path to the host config file the wiring is written into. */
  configPath: string;
}

/** A single planned change to the host config (computed, not yet applied). */
export interface InstallStep {
  kind: "create-config" | "add-wiring" | "update-wiring" | "noop";
  configPath: string;
  description: string;
}

/** The full set of changes `install({ apply:false })` would make. */
export interface InstallPlan {
  adapterId: string;
  configPath: string;
  steps: InstallStep[];
  /** True when nothing needs to change (already installed and current). */
  satisfied: boolean;
}

/** Result of actually applying an install plan. */
export interface InstallResult {
  adapterId: string;
  configPath: string;
  applied: InstallStep[];
}

/** Outcome of a real round-trip verification (write was read back correctly). */
export interface VerifyResult {
  adapterId: string;
  ok: boolean;
  /** Empty when ok; otherwise the concrete reasons verification failed. */
  problems: string[];
}

/** A doctor finding for an installed (or mis-installed) adapter. */
export interface DoctorFinding {
  code: "not-installed" | "stale-wiring" | "corrupt-config" | "ok";
  message: string;
}

/**
 * The adapter contract. Every host adapter implements this.
 *
 * `install` ALWAYS plans first; with `apply:true` it then applies and re-reads.
 * `verify` performs a real round-trip: it reads the host config back from disk
 * and confirms the wiring is present and well-formed — it never trusts a write.
 */
export interface HostAdapter {
  /** Stable identifier, e.g. "pi", "claude-code". */
  readonly id: string;
  /** Host display name. */
  readonly name: string;
  /** Host-event → scribe-hook lifecycle map (for docs + verification). */
  readonly lifecycle: LifecycleMap;
  /**
   * The host's default config file (where the wiring marker is installed) as a
   * path relative to the user's home directory, e.g. ".pi/agent/settings.json".
   * Lets `connect <host>` resolve a target with no explicit `--config`.
   */
  readonly defaultConfigRelPath?: string;
  /**
   * One-line note on how the host actually consumes the scribe. "best-effort"
   * hosts (no first-class plugin source) carry the caveat here.
   */
  readonly integrationNote?: string;

  /**
   * Wire a scribe into a live host runtime. Returns a disposer that detaches all
   * listeners. Pure event translation — no memory logic.
   */
  attach(scribe: MemScribe, host: HostRuntime): () => void;

  /** Compute the config changes needed to install the wiring (no writes). */
  install(target: InstallTarget, opts?: { apply?: boolean }): Promise<InstallPlan | InstallResult>;

  /** Read the host config back and confirm the wiring round-trips. */
  verify(target: InstallTarget): Promise<VerifyResult>;

  /** Diagnose the installed state of this adapter. */
  doctor(target: InstallTarget): Promise<DoctorFinding[]>;
}

/**
 * Minimal event surface an adapter binds to. Concrete hosts expose richer
 * objects; adapters down-cast through this for `attach`. `on` returns an
 * unsubscribe function (Node EventEmitter-compatible shape is also accepted).
 */
export interface HostRuntime {
  on(event: string, listener: (payload: unknown) => void): (() => void) | unknown;
  off?(event: string, listener: (payload: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Wiring marker — the canonical, round-trippable installed artifact
// ---------------------------------------------------------------------------

/** The current wiring schema version. Bumping this makes old wiring "stale". */
export const WIRING_VERSION = 1;

/** Key under which the wiring marker lives in a host config object. */
export const WIRING_KEY = "memscribe";

/** The marker an adapter writes into a host config to claim it is installed. */
export interface WiringMarker {
  version: number;
  adapter: string;
  /** Ordered list of (hostEvent → hook) bindings, for verification. */
  bindings: { hostEvent: string; hook: MemScribeHook }[];
}

/** Build the wiring marker for an adapter from its lifecycle map. */
export function buildWiringMarker(adapter: HostAdapter): WiringMarker {
  const bindings = (Object.values(adapter.lifecycle) as LifecycleMapping[]).map((m) => ({
    hostEvent: m.hostEvent,
    hook: m.hook,
  }));
  return { version: WIRING_VERSION, adapter: adapter.id, bindings };
}

/** Compare two markers for exact wiring equality (version + bindings). */
export function markersEqual(a: WiringMarker | undefined, b: WiringMarker): boolean {
  if (!a) return false;
  if (a.version !== b.version || a.adapter !== b.adapter) return false;
  if (a.bindings.length !== b.bindings.length) return false;
  for (let i = 0; i < b.bindings.length; i++) {
    const x = a.bindings[i];
    const y = b.bindings[i];
    if (!x || x.hostEvent !== y.hostEvent || x.hook !== y.hook) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Config I/O — atomic JSON round-trip on plain Node stdlib
// ---------------------------------------------------------------------------

/** Read and parse a host config file; `null` when absent, throws on corrupt JSON. */
export async function readHostConfig(configPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  const parsed = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`host config is not a JSON object: ${configPath}`);
  }
  return parsed as Record<string, unknown>;
}

/** Read the wiring marker out of a host config object, if present and shaped. */
export function readWiringMarker(config: Record<string, unknown> | null): WiringMarker | undefined {
  if (!config) return undefined;
  const m = config[WIRING_KEY];
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  const obj = m as Record<string, unknown>;
  if (typeof obj.version !== "number" || typeof obj.adapter !== "string") return undefined;
  if (!Array.isArray(obj.bindings)) return undefined;
  const bindings: { hostEvent: string; hook: MemScribeHook }[] = [];
  for (const b of obj.bindings) {
    if (!b || typeof b !== "object") return undefined;
    const bb = b as Record<string, unknown>;
    if (typeof bb.hostEvent !== "string" || typeof bb.hook !== "string") return undefined;
    bindings.push({ hostEvent: bb.hostEvent, hook: bb.hook as MemScribeHook });
  }
  return { version: obj.version, adapter: obj.adapter, bindings };
}

/** Atomically write a host config object as pretty JSON (temp file + rename). */
export async function writeHostConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${randomBytes(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, configPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared install / verify / doctor — every adapter reuses these
// ---------------------------------------------------------------------------

/**
 * Compute the install plan for an adapter against a host config file.
 * Pure read; never writes. `satisfied` is true when the on-disk wiring already
 * matches the adapter's current marker exactly.
 */
export async function planInstall(adapter: HostAdapter, target: InstallTarget): Promise<InstallPlan> {
  const desired = buildWiringMarker(adapter);
  let config: Record<string, unknown> | null;
  let corrupt = false;
  try {
    config = await readHostConfig(target.configPath);
  } catch {
    config = null;
    corrupt = true;
  }

  const steps: InstallStep[] = [];
  if (config === null && !corrupt) {
    steps.push({
      kind: "create-config",
      configPath: target.configPath,
      description: `create host config and add MemScribe wiring for "${adapter.id}"`,
    });
    return { adapterId: adapter.id, configPath: target.configPath, steps, satisfied: false };
  }

  if (corrupt) {
    steps.push({
      kind: "update-wiring",
      configPath: target.configPath,
      description: `rewrite corrupt host config and add MemScribe wiring for "${adapter.id}"`,
    });
    return { adapterId: adapter.id, configPath: target.configPath, steps, satisfied: false };
  }

  const existing = readWiringMarker(config);
  if (markersEqual(existing, desired)) {
    steps.push({
      kind: "noop",
      configPath: target.configPath,
      description: `wiring for "${adapter.id}" already current`,
    });
    return { adapterId: adapter.id, configPath: target.configPath, steps, satisfied: true };
  }

  steps.push({
    kind: existing ? "update-wiring" : "add-wiring",
    configPath: target.configPath,
    description: existing
      ? `update stale MemScribe wiring for "${adapter.id}" (v${existing.version} → v${desired.version})`
      : `add MemScribe wiring for "${adapter.id}"`,
  });
  return { adapterId: adapter.id, configPath: target.configPath, steps, satisfied: false };
}

/**
 * Apply an adapter's install: plan, then (if needed) merge the wiring marker
 * into the host config and write it atomically, preserving all other keys.
 */
export async function applyInstall(adapter: HostAdapter, target: InstallTarget): Promise<InstallResult> {
  const plan = await planInstall(adapter, target);
  if (plan.satisfied) {
    return { adapterId: adapter.id, configPath: target.configPath, applied: [] };
  }

  let config: Record<string, unknown> | null;
  try {
    config = await readHostConfig(target.configPath);
  } catch {
    config = null; // corrupt → overwrite
  }
  const next: Record<string, unknown> = { ...(config ?? {}) };
  next[WIRING_KEY] = buildWiringMarker(adapter);
  await writeHostConfig(target.configPath, next);

  return {
    adapterId: adapter.id,
    configPath: target.configPath,
    applied: plan.steps.filter((s) => s.kind !== "noop"),
  };
}

/**
 * Real round-trip verification: read the config back from disk and confirm the
 * wiring marker is present and exactly matches the adapter's current marker.
 * Never trusts an in-memory write — always re-reads.
 */
export async function verifyInstall(adapter: HostAdapter, target: InstallTarget): Promise<VerifyResult> {
  const desired = buildWiringMarker(adapter);
  const problems: string[] = [];
  let config: Record<string, unknown> | null;
  try {
    config = await readHostConfig(target.configPath);
  } catch (err) {
    return {
      adapterId: adapter.id,
      ok: false,
      problems: [`host config is corrupt: ${(err as Error).message}`],
    };
  }
  if (config === null) {
    return { adapterId: adapter.id, ok: false, problems: ["host config does not exist"] };
  }
  const existing = readWiringMarker(config);
  if (!existing) {
    problems.push("no MemScribe wiring marker found in host config");
    return { adapterId: adapter.id, ok: false, problems };
  }
  if (existing.adapter !== desired.adapter) {
    problems.push(`wiring belongs to adapter "${existing.adapter}", expected "${desired.adapter}"`);
  }
  if (existing.version !== desired.version) {
    problems.push(`wiring version ${existing.version} != expected ${desired.version}`);
  }
  if (!markersEqual(existing, desired)) {
    problems.push("wiring bindings do not match the adapter's current lifecycle map");
  }
  return { adapterId: adapter.id, ok: problems.length === 0, problems };
}

/**
 * Resolve the install target for an adapter. An explicit `configPath` always
 * wins; otherwise the adapter's `defaultConfigRelPath` is resolved under the
 * user's home directory. Throws when neither is available.
 */
export function resolveInstallTarget(
  adapter: HostAdapter,
  configPath?: string,
): InstallTarget {
  if (configPath && configPath.trim() !== "") {
    return { configPath };
  }
  if (adapter.defaultConfigRelPath) {
    return { configPath: path.join(homedir(), adapter.defaultConfigRelPath) };
  }
  throw new Error(
    `adapter "${adapter.id}" has no default config path; pass an explicit configPath`,
  );
}

/** Outcome of {@link connect}: the plan/result plus the verification round-trip. */
export interface ConnectResult {
  adapterId: string;
  configPath: string;
  /** The plan (apply:false) or the applied result (apply:true). */
  install: InstallPlan | InstallResult;
  /** Present only when `apply:true`: the real re-read-from-disk verification. */
  verify?: VerifyResult;
}

/**
 * One-call install + verify. Resolves the target (explicit path or the
 * adapter's default), plans the wiring, optionally applies it, then — when
 * applied — re-reads from disk and verifies the marker round-trips. This is the
 * mechanism behind a CLI `connect <host>` command.
 */
export async function connect(
  adapter: HostAdapter,
  opts: { configPath?: string; apply?: boolean } = {},
): Promise<ConnectResult> {
  const target = resolveInstallTarget(adapter, opts.configPath);
  if (!opts.apply) {
    const plan = await planInstall(adapter, target);
    return { adapterId: adapter.id, configPath: target.configPath, install: plan };
  }
  const result = await applyInstall(adapter, target);
  const verify = await verifyInstall(adapter, target);
  return { adapterId: adapter.id, configPath: target.configPath, install: result, verify };
}

/** Diagnose installed state by re-reading the config (shared doctor). */
export async function doctorInstall(adapter: HostAdapter, target: InstallTarget): Promise<DoctorFinding[]> {
  let config: Record<string, unknown> | null;
  try {
    config = await readHostConfig(target.configPath);
  } catch (err) {
    return [{ code: "corrupt-config", message: `host config is not valid JSON: ${(err as Error).message}` }];
  }
  if (config === null) {
    return [{ code: "not-installed", message: `no host config at ${target.configPath}` }];
  }
  const existing = readWiringMarker(config);
  if (!existing) {
    return [{ code: "not-installed", message: `MemScribe wiring not present in ${target.configPath}` }];
  }
  const desired = buildWiringMarker(adapter);
  if (!markersEqual(existing, desired)) {
    return [
      {
        code: "stale-wiring",
        message: `installed wiring (v${existing.version}, ${existing.bindings.length} bindings) differs from current; run install to update`,
      },
    ];
  }
  return [{ code: "ok", message: `adapter "${adapter.id}" installed and current` }];
}

// ---------------------------------------------------------------------------
// Generic attach — bind host events to scribe hooks per the lifecycle map
// ---------------------------------------------------------------------------

/**
 * Per-adapter translation of a raw host payload into the arguments a scribe hook
 * needs. Adapters supply this; everything else (binding, disposal) is shared.
 */
export interface HookTranslators {
  /** Pull the sessionId out of a session-start payload. */
  sessionId(payload: unknown): string;
  /** Pull a sessionId for prompt-build; defaults to `sessionId`. */
  promptSessionId?(payload: unknown): string;
  /** Pull (sessionId, messages) out of a turn-end payload. */
  turnEnd(payload: unknown): { sessionId: string; messages: MemScribeMessage[] };
  /** Pull a sessionId for session-end; defaults to `sessionId`. */
  sessionEndSessionId?(payload: unknown): string;
  /** Map an idle payload to onIdle input; defaults to `{}`. */
  idle?(payload: unknown): { force?: boolean } | undefined;
}

/**
 * Bind a scribe's hooks to a host runtime using the adapter's lifecycle map and
 * translators. Returns a disposer that removes every listener. This is the only
 * place host events touch the scribe — pure translation, no memory logic.
 *
 * `onPromptBuild` returns a `MemScribeContext`; the host is expected to read it from
 * the listener's return value (hosts that need the result pass a payload with a
 * `respond` callback — see the per-host adapters).
 */
export function bindLifecycle(
  scribe: MemScribe,
  host: HostRuntime,
  lifecycle: LifecycleMap,
  translators: HookTranslators,
): () => void {
  const disposers: Array<() => void> = [];

  const subscribe = (event: string, listener: (payload: unknown) => void): void => {
    const ret = host.on(event, listener);
    if (typeof ret === "function") {
      disposers.push(ret as () => void);
    } else if (typeof host.off === "function") {
      disposers.push(() => host.off!(event, listener));
    }
  };

  // Fire-and-forget: swallow rejections so a failing hook never blocks, crashes,
  // or throws into the host's event loop.
  const detach = (p: Promise<unknown>): void => {
    p.catch(() => {});
  };

  if (lifecycle.onSessionStart) {
    subscribe(lifecycle.onSessionStart.hostEvent, (payload) => {
      detach(scribe.onSessionStart({ sessionId: translators.sessionId(payload) }));
    });
  }

  if (lifecycle.onPromptBuild) {
    subscribe(lifecycle.onPromptBuild.hostEvent, (payload) => {
      const sessionId = (translators.promptSessionId ?? translators.sessionId)(payload);
      const result = scribe.onPromptBuild({ sessionId });
      // Hosts that need the context attach a `respond` callback to the payload.
      const respond = (payload as { respond?: (ctx: Promise<MemScribeContext>) => void } | undefined)?.respond;
      if (typeof respond === "function") respond(result);
      else detach(result);
    });
  }

  if (lifecycle.onTurnEnd) {
    subscribe(lifecycle.onTurnEnd.hostEvent, (payload) => {
      const { sessionId, messages } = translators.turnEnd(payload);
      // Fire-and-forget: never block the host's stream.
      detach(scribe.onTurnEnd({ sessionId, messages }));
    });
  }

  if (lifecycle.onSessionEnd) {
    subscribe(lifecycle.onSessionEnd.hostEvent, (payload) => {
      const sessionId = (translators.sessionEndSessionId ?? translators.sessionId)(payload);
      detach(scribe.onSessionEnd({ sessionId }));
    });
  }

  if (lifecycle.onIdle) {
    subscribe(lifecycle.onIdle.hostEvent, (payload) => {
      const input = (translators.idle ?? (() => undefined))(payload);
      detach(scribe.onIdle(input));
    });
  }

  return () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch {
        // ignore disposer errors
      }
    }
  };
}
