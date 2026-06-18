/** Registry of all built-in host adapters, keyed by id. */

import type { HostAdapter } from "./adapter.js";
import { piAdapter } from "./pi.js";
import { hermesAdapter } from "./hermes.js";
import { opencodeAdapter } from "./opencode.js";
import { openclawAdapter } from "./openclaw.js";
import { codexAdapter } from "./codex.js";
import { claudeCodeAdapter } from "./claude-code.js";

/** Every built-in adapter. */
export const ADAPTERS: readonly HostAdapter[] = [
  piAdapter,
  hermesAdapter,
  opencodeAdapter,
  openclawAdapter,
  codexAdapter,
  claudeCodeAdapter,
];

const BY_ID: ReadonlyMap<string, HostAdapter> = new Map(ADAPTERS.map((a) => [a.id, a]));

/** Look up an adapter by its id; `undefined` when unknown. */
export function getAdapter(id: string): HostAdapter | undefined {
  return BY_ID.get(id);
}

/** All known adapter ids. */
export function adapterIds(): string[] {
  return ADAPTERS.map((a) => a.id);
}
