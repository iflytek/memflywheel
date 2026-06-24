# MemFlywheel Implementation Blueprint

> A minimal, open-source implementation of a file-native long-term memory subsystem.
> This document is a **design blueprint** — no implementation code, only structure, contracts, and signatures.

---

## 0. Guiding Constraints (non-negotiable)

- **Zero runtime dependencies.** Node stdlib + TypeScript only. No npm runtime deps, ever. Frontmatter parsing, atomic writes, locking — all hand-rolled on `node:fs/promises`, `node:path`, `node:crypto`.
- **Core never owns model/auth.** Extraction and dream LLM steps are **pluggable injection points** (function contracts) supplied by the host/SDK. Optional index retrieval consumes a host-supplied embedding provider. Core owns timing, locking, atomic writes, index sync, cursor/relocation, audit.
- **File-backed storage.** Each memory = Markdown body + tight YAML frontmatter (`name` / `description` / `type` / optional `occurred_on` / `retrieval_terms`). Markdown is the source of truth; `MEMORY.md` is a rebuildable derived index.
- **Progressive index recall.** Small stores inject the whole index. Large stores may use host-supplied embedding + BM25 + RRF over `MEMORY.md` index lines only, then inject top index cues plus a `MEMORY.md` fallback. Memory bodies are not embedded or searched.
- **No scope.** A single global store only — no per-user/project/workspace memory directory (see §13).
- **Style:** double quotes, 2-space indent, named exports only, `async/await`, `node:fs/promises`. No AI/assistant attribution anywhere.
- **Tests:** `node:test` + `node:assert`, compiled by `tsc` then run via `node --test`.

---

## 1. Monorepo Structure

```
MemFlywheel/
├── package.json                 # root, private, workspace scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json           # shared strict NodeNext config
├── README.md
├── LICENSE                      # (present)
├── .gitignore                   # (present)
└── packages/
    ├── core/                    # @memflywheel/core   — memory kernel (no LLM, no host)
    ├── model/                   # @memflywheel/model  — provider-neutral canonical model protocol
    ├── sdk/                     # @memflywheel/sdk    — lifecycle hooks + extraction/dream/skill orchestration
    ├── skills/                  # @memflywheel/skills — learned skill store + validation
    └── adapters/                # @memflywheel/adapters  — host lifecycle mappings
```

### Root `package.json` (shape, not literal)

```
{
  "name": "memflywheel",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "clean": "pnpm -r run clean"
  }
}
```

### `pnpm-workspace.yaml`

```
packages:
  - "packages/*"
```

### `tsconfig.base.json` (key compiler options)

```
target: ES2022
module: NodeNext
moduleResolution: NodeNext
strict: true
declaration: true
declarationMap: true
sourceMap: true
verbatimModuleSyntax: true
outDir: dist
rootDir: src
```

### Per-package layout (uniform)

```
packages/<pkg>/
├── package.json     # name, "type":"module", exports → dist/index.js, scripts build/test/clean
├── tsconfig.json    # extends ../../tsconfig.base.json, references its deps
├── README.md
└── src/
    ├── index.ts                 # named re-exports of public surface
    ├── <module>.ts
    └── <module>.test.ts         # node:test, compiled then `node --test dist/...`
```

Each package `package.json` scripts:
- `build`: `tsc -b`
- `test`: `tsc -b && node --test dist/**/*.test.js`
- `clean`: `rm -rf dist`

Dependency edges (workspace-internal only, via `workspace:*`):
- `sdk` → `core`
- `model` → no workspace package
- `skills` → no workspace package
- `adapters` → `sdk`, `model`

---

## 2. Frontmatter & Domain Types (`@memflywheel/core`)

Only the **minimal** fields. `name` + `type` are required by the parser; `description` is optional (defaults to `""`). `created_at` / `updated_at` are the minimal-necessary additions.

```ts
// The six categories (VALID_MEMORY_TYPES).
export type MemoryType =
  | "identity"
  | "preference"
  | "style"
  | "workflow"
  | "context"
  | "ambient";

// Persisted YAML frontmatter. NOTHING beyond these fields.
// (No scope / origin / source_ref / confidence / status / agent / project / session.)
export interface MemoryFrontmatter {
  name: string;          // required, unique display name
  description: string;   // optional in file; normalized to "" when absent
  type: MemoryType;      // required, must be one of the six
  occurred_on?: string;  // optional event date, YYYY-MM-DD
  retrieval_terms?: string[]; // optional old files; required for new/updated extraction writes
  created_at?: string;   // ISO 8601, minimal-necessary
  updated_at?: string;   // ISO 8601, minimal-necessary
}

// A parsed memory file (frontmatter + body).
export interface MemoryDocument {
  frontmatter: MemoryFrontmatter;
  body: string;          // markdown after the closing "---", trimmed
}

// Scan entry — the scanMemoryFiles() output shape.
export interface MemoryEntry {
  filename: string;       // basename, e.g. "user-name.md"
  relativePath: string;   // forward-slash, e.g. "identity/user-name.md"
  name: string;
  description: string;    // "" when absent
  type: MemoryType;
  mtime: number;          // stat.mtimeMs
}

export const VALID_MEMORY_TYPES: ReadonlySet<MemoryType>;
export const MEMORY_TYPE_DIRECTORIES: Readonly<Record<MemoryType, string>>; // identity→"identity", ...
export const RESERVED_MEMORY_FILES: ReadonlySet<string>;
//   { "MEMORY.md", ".memory-task-lock", ".last-extraction", ".consolidate-lock", ".audit.log" }
```

---

## 3. `@memflywheel/core` — Module Map

```
core/src/
├── index.ts            # public surface re-exports
├── types.ts            # §2 types + constants
├── paths.ts            # root resolution, typed dirs, filename validation
├── frontmatter.ts      # parse / serialize YAML frontmatter (no deps)
├── storage.ts          # read/write/delete a single memory doc (atomic)
├── scan.ts             # scanMemoryFiles, scanAllMemoryFiles, readAllMemoryContents, formatManifest
├── index-file.ts       # MEMORY.md: build / truncate / aging / sync
├── recall.ts           # buildContext: stable rules + full/retrieved index prelude
├── privacy.ts          # <private> redaction + secret scanning
├── lock.ts             # per-root write lock (stale detection)
├── atomic.ts           # temp-file + rename atomic write
├── audit.ts            # append-only audit log
├── extract.ts          # runExtractionSession lifecycle + ExtractionAgentRunner contract
├── file-tools.ts     # glob / grep / read / write / edit / bash
├── dream.ts            # deterministic pre-pass + runDreamSession + DreamAgentRunner contract
└── health.ts           # structural findings (used by dream + host diagnostics)
```

Each module's job + key signatures below. All async I/O is `node:fs/promises`.

---

### 3.1 `paths.ts`

Root resolution and filename validation, minus workspace scoping.

```ts
// Root: env override → OS default. NO Electron app.getPath; pure Node.
//   MEMFLYWHEEL_HOME env wins; else <os-data-dir>/memflywheel/memory.
export function getMemoryRoot(opts?: { root?: string }): string;
export function ensureMemoryDir(root: string): Promise<void>;

// type → absolute typed directory, or null for invalid type.
export function getTypedMemoryDir(root: string, type: string): string | null;

// (type, flat-filename) → absolute path, or null if invalid.
// Rejects nested paths (segments.length !== 1), reserved names, traversal.
export function getTypedMemoryPath(root: string, type: string, filename: string): string | null;

// Full validation, isValidMemoryFilename:
//  non-empty string, no NUL, normalized slashes, not absolute, no "."/".."/hidden
//  segments, normalize-stable, basename ends ".md", not reserved, stays in root.
export function isValidMemoryFilename(root: string, filename: string): boolean;

export function normalizeRelativePath(p: string): string; // "\\" → "/"
```

> **Design note:** `root` is threaded explicitly (not a module singleton) so the kernel is testable and embeddable. The SDK/adapters resolve it once via `getMemoryRoot()` and pass it down.

---

### 3.2 `frontmatter.ts`

Hand-rolled, line-based parser (NOT a full YAML lib — zero deps).

```ts
// parseMemoryFrontmatter:
//  - line[0] must be "---"
//  - closing "---" within first 30 lines
//  - each "key: value" via /^(\w+):\s*(.+)$/
//  - require name + type; type ∈ VALID_MEMORY_TYPES; else null
export function parseFrontmatter(content: string): MemoryFrontmatter | null;

// Split into { frontmatter, body } (body = stripFrontmatter, trimmed). null if invalid.
export function parseDocument(content: string): MemoryDocument | null;

// stripFrontmatter port: returns body after closing "---" (trimmed), or whole content.
export function stripFrontmatter(content: string): string;

// Deterministic serializer: emits "---\n" + ordered keys + "---\n\n" + body + "\n".
// Key order fixed: name, description, type, created_at, updated_at.
// Values are single-line; multi-line values are rejected upstream (write tools).
export function serializeDocument(doc: MemoryDocument): string;
```

> **Constraint:** the parser reads at most the first `FRONTMATTER_READ_BYTES = 2048` of a file when only metadata is needed (scan path), full content otherwise.

---

### 3.3 `storage.ts`

Single-document CRUD over typed dirs, atomic.

```ts
export interface StorageContext {
  root: string;
  audit: AuditLogger;        // §3.10
}

// Read+parse one doc by relativePath. null on ENOENT / invalid.
export function readMemoryDocument(ctx: StorageContext, relativePath: string): Promise<MemoryDocument | null>;

// Write/overwrite a doc into its typed dir (atomic). Stamps updated_at; created_at on first write.
// Validates filename + frontmatter + privacy BEFORE writing (throws on secret/invalid).
// Returns the relativePath actually written.
export function writeMemoryDocument(
  ctx: StorageContext,
  input: { type: MemoryType; filename: string; doc: MemoryDocument }
): Promise<string>;

// Delete a doc (used by dream apply). Append audit.
export function deleteMemoryDocument(ctx: StorageContext, relativePath: string): Promise<boolean>;
```

All writes go through `atomic.ts` and emit `audit.ts` records.

---

### 3.4 `scan.ts`

The scan layer.

```ts
// Recursive walk: skip hidden dirents, *.md only, skip RESERVED_MEMORY_FILES,
// parse frontmatter header (first 2048 bytes), sort by mtime DESC, slice(0, 200).
export const MAX_SCAN_ENTRIES = 200;
export function scanMemoryFiles(root: string): Promise<MemoryEntry[]>;

// readAllMemoryContents: concatenated bodies "### name (type)\n\n<body>"
// joined by "\n\n---\n\n", capped at maxTotalBytes (default 30*1024).
export function readAllMemoryContents(root: string, maxTotalBytes?: number): Promise<string>;

// formatManifest: "- [type] relativePath (YYYY-MM-DD): description" per line,
// or "（无现有记忆）" when empty. Consumed by extract/dream prompt builders.
export function formatManifest(entries: MemoryEntry[]): string;
```

---

### 3.5 `index-file.ts`

The derived-index layer. **MEMORY.md is derived, never authored by the LLM.**

```ts
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25000;

// AGING_THRESHOLDS: identity/preference/style/workflow = null (permanent);
// context/ambient = 30*24*60*60*1000 ms.
export const AGING_THRESHOLDS: Readonly<Record<MemoryType, number | null>>;

// buildMemoryIndexContent:
//   "- [name](<absPath>) - <description|（无描述）> (type: <type>, path: <relPath>)"
export function buildIndexContent(entries: MemoryEntry[]): string;

// truncateIndex: cap to 200 lines, then to 25000 UTF-8 bytes (pop lines);
// if truncated, append the exact truncation HTML comment marker.
export function truncateIndex(content: string): string;

// applyAgingHints: for context/ambient entries older than threshold,
// append "（此记忆已有 N 天未更新，使用前建议验证）" to the matching index line via the
// same path|filename regex anchored at line end.
export function applyAgingHints(content: string, entries: MemoryEntry[]): string;

// syncMemoryIndex: rebuild MEMORY.md from entries (or fresh scan) and write it.
export function syncMemoryIndex(root: string, entries?: MemoryEntry[]): Promise<string>;

// Read MEMORY.md; "" on ENOENT.
export function readMemoryIndex(root: string): Promise<string>;
```

---

### 3.6 `recall.ts` — `buildContext` (the two-segment injection)

This is MemFlywheel's recall path: a knowledge-layer build that assembles the two injection segments. Small indexes are injected whole; larger indexes can use optional index-layer hybrid retrieval.

```ts
export interface BuildContextResult {
  // Segment 1: STABLE memory rules → host puts in systemPrompt (cache-friendly prefix).
  systemPrompt: string;
  // Segment 2: DYNAMIC prelude = full or retrieved MEMORY.md index cues, wrapped in <system-reminder>.
  // Host injects this immediately before the user message, every turn.
  preludePrompt: string;
  enabled: boolean;
}

// Pipeline (deterministic, no LLM):
//   scanMemoryFiles → syncMemoryIndex → readMemoryIndex → truncateIndex → applyAgingHints
//   → systemPrompt = buildMemoryInstructionPrompt()
//   → preludePrompt = buildMemoryIndexPrompt(hintedIndex)
export function buildContext(opts: {
  root: string;
  enabled?: boolean;        // false ⇒ both strings "", enabled:false (no scan/inject)
}): Promise<BuildContextResult>;

// Stable rules text. buildMemoryInstructionPrompt (recall + save + 禁止事项).
export function buildMemoryInstructionPrompt(): string;

// buildMemoryIndexPrompt: returns
//   "<system-reminder>\n## 可用记忆条目\n\n<index>\n\n<closing line>\n</system-reminder>"
//   empty-index variant uses the "当前没有可用记忆条目..." body.
export function buildMemoryIndexPrompt(indexContent: string): string;
```

> **Why two segments:** the rules are a stable cache-friendly prefix; the index churns every turn, so it rides in a `<system-reminder>` prelude before the user message. The prelude wrapper is mandatory (bare strings would leak into user-visible bubbles in some hosts).

---

### 3.7 `privacy.ts`

Privacy threat-scan (locked behavior).

```ts
// Replace <private>...</private> spans with "[REDACTED]" (multiline, non-greedy).
export function redactPrivateSpans(text: string): string;

export interface SecretFinding {
  kind: "token" | "password" | "api-key" | "cookie" | "ssh-key";
  excerpt: string;   // masked, for audit only — never the raw secret
}

// Heuristic scan for obvious secrets (token/password/api key/cookie/ssh key).
export function scanSecrets(text: string): SecretFinding[];

// Convenience: redact private spans, then throw if any hard secret remains.
// Used by storage.writeMemoryDocument (driven by the memory write tools) before any write.
export function enforceWritePrivacy(text: string): string;
```

> **Policy:** `<private>` → `[REDACTED]` (soft). Obvious secrets → **refuse the write** (hard). Never persist or log the raw secret.

---

### 3.8 `lock.ts`

Per-root mutex: `acquireLock` / `releaseLock`.

```ts
export const LOCK_TIMEOUT_MS = 3 * 60 * 1000;  // 180s
export const LOCK_FILE = ".memory-task-lock";

export interface LockHandle { acquired: boolean; lockPath: string; }

// Read existing lock JSON { pid, owner, startedAt }.
// Stale if process.kill(pid,0) throws OR (now - startedAt) > LOCK_TIMEOUT_MS → unlink & retake.
// Atomic create with flag "wx"; EEXIST ⇒ { acquired:false }.
export function acquireLock(root: string, owner?: string): Promise<LockHandle>;
export function releaseLock(root: string): Promise<void>;
```

---

### 3.9 `atomic.ts`

```ts
// Write to "<target>.<random>.tmp" in the same dir, fsync, then rename over target.
// rename is atomic on the same filesystem; mkdir -p the parent first.
export function atomicWriteFile(target: string, data: string): Promise<void>;
```

---

### 3.10 `audit.ts`

Append-only audit trail (CONTEXT: append-only audit).

```ts
export type AuditAction = "write" | "delete" | "extract" | "dream-apply" | "relocate" | "archive";

export interface AuditRecord {
  ts: string;            // ISO 8601
  action: AuditAction;
  path?: string;
  detail?: string;       // never contains raw secrets
}

export interface AuditLogger {
  append(record: AuditRecord): Promise<void>;
}

// File-backed logger → "<root>/.audit.log" (JSONL), append-only, atomic-append.
export function createAuditLogger(root: string): AuditLogger;
```

---

### 3.11 `extract.ts` — extraction kernel + **pluggable agent-runner contract**

Core owns the full `runExtractionSession` lifecycle **except the LLM call**, which is injected. Extraction is a tool-calling subagent that **writes the memory files itself** through core's write tools — there are no candidates for core to validate. Core also ships the default extraction system prompt and the write tools (`file-tools.ts`) as **pure values** (no network call); the SDK assembles them into a running subagent loop (§4.3).

#### The injection point (the contract host/SDK implements)

```ts
// Minimal transcript shape handed to the subagent.
export interface ExtractionMessage { role: "user" | "assistant"; text: string; }

// THE pluggable injection point. The SDK supplies a tool-calling agent loop here;
// core calls it inside the held write lock. The runner writes memories itself via
// the supplied tools (bound to the same context, so they share the lock). Core
// never calls an LLM — it calls this.
export type ExtractionAgentRunner = (input: {
  toolCtx: FileToolContext;      // bound to the held write lock
  tools: FileTool[];             // from createFileTools()
  messages: ExtractionMessage[];   // selected window (see selection below)
  manifest: string;                // formatManifest(existing entries)
  root: string;
}) => Promise<{ changed: string[] }>;
```

#### Default prompt + write tools (pure values in core — no network)

```ts
// The curated default extraction system prompt. A plain string constant.
// Encodes: what is worth long-term memory vs forbidden (one-off questions,
// transient/temporary state, anything with an explicit time boundary); high-risk
// private content that must never be extracted (national IDs, bank-card numbers,
// tokens/keys, medical details, income, third-party private data); the six types
// with definitions; positive/negative examples; the instruction to WRITE with the
// tools (glob → write / edit / bash), not return JSON.
export const DEFAULT_EXTRACTION_SYSTEM_PROMPT: string;

// Render the seed user message for one turn (manifest + conversation window).
export function buildExtractionAgentUserMessage(input: {
  messages: ExtractionMessage[];
  manifest: string;
}): string;

// The memory write tools the subagent drives. Each tool is JSON-schema-described
// with a handler that does path-safety validation + atomic write + audit append +
// index resync. glob is read-only.
export function createFileTools(): FileTool[];   // file-tools.ts
```

> Core holds the prompt string, the seed-message builder, and the write tools only — it never makes an LLM call. The SDK's `createExtractionAgentRunner({ model })` drives a tool-calling loop over them into a full `ExtractionAgentRunner` (§4.3).

#### Selection / message-window helpers

```ts
export const EXTRACTION_CONTEXT_WINDOW_SIZE = 6;
export const EXTRACTION_MAX_MESSAGES = 40;

// selectMessagesForExtraction: cursor-based windowing.
export function selectMessagesForExtraction(
  messages: ExtractionMessage[],
  cursorIndex: number | null
): ExtractionMessage[];

// Strip <system-reminder> blocks + prelude patterns from user turns;
// keep assistant turns verbatim.
export function stripSystemReminderBlocks(text: string): string;
```

#### Write tools + run

```ts
// Each write tool routes through the storage layer (file-tools.ts), which
// enforces: valid type, safe flat filename, single-line frontmatter values,
// body non-empty, privacy (always redact <private>; optionally refuse hard
// secrets via the refuseSecrets gate), atomic write, audit append, index resync.
export interface FileTool {
  name: "read" | "write" | "edit" | "bash" | "glob" | "grep";
  description: string;
  inputSchema: JsonSchema;
  handler: (args: unknown, toolCtx: FileToolContext) => Promise<FileToolResult>;
}

export enum ExtractionResult { Queued = "queued", Completed = "completed", Skipped = "skipped", Failed = "failed" }

// FULL lifecycle, LLM via injected ExtractionAgentRunner:
//  1 acquireLock (else enqueue → Queued)
//  2 relocateRootFiles (normalizeMemoryLocations port)
//  3 before = scanMemoryFiles → manifest
//  4 select window via cursor
//  5 build bound tools + toolCtx (sharing the lock); changed = await agent({...})
//    — the subagent acts through read/write/edit/bash/glob/grep
//  6 relocateRootFiles again
//  7 after = scanMemoryFiles → syncMemoryIndex
//  8 advance cursor ONLY on success; stamp .last-extraction
//  9 releaseLock; drain pending queue
export function runExtractionSession(opts: {
  ctx: StorageContext;
  agent: ExtractionAgentRunner;
  messages: ExtractionMessage[];
  sessionId: string;
  cursorStore: CursorStore;      // §3.11a
}): Promise<ExtractionResult>;
```

#### 3.11a Cursor + pending queue

```ts
// Per-session "last processed message" cursor (avoids re-extracting). In-memory by default;
// SDK may persist. Advance only after a successful extraction.
export interface CursorStore {
  get(sessionId: string): number | null;
  set(sessionId: string, cursorIndex: number): void;
}
export function createMemoryCursorStore(): CursorStore;

// normalizeMemoryLocations: move stray root-level *.md into their typed dir
// based on frontmatter.type; on conflict keep the newer mtime. Returns moved relPaths.
export function relocateRootFiles(ctx: StorageContext): Promise<string[]>;
```

> **ADD-only discipline:** new facts always create/refresh files. An old memory is archived **only** when the user explicitly corrects it (`candidate.archives`). No silent overwrite-as-correction.

---

### 3.12 `dream.ts` — consolidation: deterministic pre-pass + **tool-calling consolidation subagent**

Dream is symmetric to extraction: a deterministic, LLM-free structural pre-pass runs first, then a pluggable consolidation **subagent** reads full bodies and merges / compresses / retires memories by calling the ordinary file tools directly. The tool calls ARE the changes — there is no JSON op format to emit or parse, and "nothing to consolidate" is simply making no tool calls. `runDreamSession` holds the per-root write lock across both phases.

```ts
// The deterministic, LLM-free structural ops — the only two unambiguous fixes.
// Everything semantic (near-duplicate merges, compression, type re-judgement) is
// the subagent's job, via the ordinary file tools.
export type DreamOp =
  | { kind: "delete-duplicate"; path: string }
  | { kind: "relocate"; path: string; toType: MemoryType };

// THE pluggable dream injection point — symmetric to ExtractionAgentRunner. The
// subagent gets the structural packets + the bound ordinary file tools/context (sharing
// the held lock) and consolidates by calling those tools. It returns the union of
// relative paths it changed.
export type DreamAgentRunner = (input: {
  root: string;
  toolCtx: FileToolContext;
  tools: FileTool[];
  health: HealthFinding[];                 // §3.13
  typeReview: { path: string; type: MemoryType; name: string; description: string; excerpt: string }[];
  manifest: string;
  index: string;                           // current MEMORY.md
  coordination?: { reason: string; memoryAction: string; topics: string[] };
}) => Promise<{ changed: string[] }>;

// Default consolidation system prompt + seed-message builder (pure values in core —
// no network, no parser). The prompt encodes the consolidation policy (merge
// near-duplicates KEEPING every item, compress verbose notes to short trigger
// signals, retire superseded entries) and the read-before-merge rule: never author
// a merged/compressed body from an excerpt — read the full body first.
export const DEFAULT_DREAM_SYSTEM_PROMPT: string;
export function buildDreamAgentUserMessage(input: {
  health: HealthFinding[];
  typeReview: { path: string; type: MemoryType; name: string; description: string; excerpt: string }[];
  manifest: string;
  index: string;
  coordination?: { reason: string; memoryAction: string; topics: string[] };
}): string;

// The SDK's createDreamAgentRunner({ model }) seeds the shared tool-agent
// loop with DEFAULT_DREAM_SYSTEM_PROMPT + buildDreamAgentUserMessage into a full
// DreamAgentRunner (§4.3). The SAME canonical model channel drives extraction.

// Deterministic plan (no LLM): from health findings + duplicate/content analysis.
export function planDeterministic(root: string, entries: MemoryEntry[]): Promise<DreamOp[]>;
export function planDream(opts: { root: string }): Promise<DreamOp[]>;

// Apply a deterministic plan, then relocate stray root files + syncMemoryIndex.
export function applyDream(opts: {
  ctx: StorageContext;
  plan: DreamOp[];
}): Promise<{ changed: string[]; deleted: string[] }>;

// THE session closure: holds the per-root write lock (owner="dream") across the
// deterministic pre-pass + the subagent (if a runner is given) over the cleaned
// state, then relocateRootFiles + syncMemoryIndex. A thrown subagent ⇒ reason
// "runner-failed", but the deterministic pre-pass already applied. The gate
// (.dream-state.json) is advanced ONLY on reason "ok" — a failed pass leaves the
// gate untouched so the next idle tick retries instead of waiting a full window.
export function runDreamSession(opts: {
  ctx: StorageContext;
  runner?: DreamAgentRunner;
  coordination?: { reason: string; memoryAction: string; topics: string[] };
  refuseSecrets?: boolean;
}): Promise<{ ran: boolean; reason: string; deterministic: DreamOp[]; changed: string[]; deleted: string[] }>;

export const DREAM_DEFAULT_MIN_HOURS = 24;
export const DREAM_DEFAULT_MIN_SESSIONS = 5;
```

> **No post-hoc frontmatter "stabilization."** The subagent's writes go through the same validated ordinary file tools as extraction (single-line name/description, valid type), and `edit` preserves frontmatter unless explicitly overridden — so deliberate, validated edits are trusted rather than reverted from a snapshot. The read-before-merge rule (read the full body before merging/compressing) is what prevents data loss, exactly as read-before-update protects list-type appends in extraction.

> **Scope: whole-store consolidation, not conversation review.** Dream reviews the current memory store (health / type / duplicates / compression). As a host-agnostic library MemFlywheel has no in-process session registry or transcript store, so the dream subagent does **not** read recent host conversations — its only conversational cue is the optional `coordination` directive, through which a host may pass recently-derived hints (e.g. a topic to compress). The gate's session count is likewise a counter the scribe keeps (`.dream-state.json`, bumped on session end, reset on a successful pass), not a scan of past sessions.

---

### 3.13 `health.ts`

Structural health findings. Used by `dream.planDeterministic` and host diagnostics.

```ts
export type HealthCode =
  | "missing-frontmatter"
  | "missing-frontmatter-name"
  | "missing-frontmatter-type"
  | "invalid-frontmatter-type"
  | "path-type-mismatch"
  | "duplicate-name-type"
  | "duplicate-content";

export interface HealthFinding {
  severity: "error" | "warn";
  code: HealthCode;
  paths: string[];     // sorted, deduped
  message: string;
}

// Scan all *.md, validate frontmatter structure/fields/type, check path-vs-type,
// group type::name for identity dupes, normalized-body for content dupes.
// Sorted by code order then path.
export function buildHealthFindings(root: string): Promise<HealthFinding[]>;
```

---

## 4. `@memflywheel/sdk` — lifecycle hooks + extraction-subagent wiring

The SDK is the thin host-facing layer that orchestrates core around a conversation lifecycle and **exposes the injection points** so a host wires in its own LLM.

```
sdk/src/
├── index.ts
├── memory-scribe.ts      # createMemFlywheel factory (the main object)
├── hooks.ts            # lifecycle hook types
└── memory-scribe.test.ts
```

### 4.1 Factory + config

```ts
export interface MemFlywheelConfig {
  root?: string;                 // default getMemoryRoot()
  enabled?: boolean;             // default true
  agent?: ExtractionAgentRunner; // §3.11 — extraction subagent injection point (optional)
  dreamRunner?: DreamAgentRunner; // §3.12 — dream consolidation subagent injection point (optional)
  refuseSecrets?: boolean;       // optional hard-secret gate (default off)
  dream?: { minHours?: number; minSessions?: number; auto?: boolean };
}

export interface MemFlywheel {
  // ---- Lifecycle hooks (host calls these) ----
  onSessionStart(input: { sessionId: string }): Promise<void>;
  // Returns the two recall segments; host merges systemPrompt into its prompt
  // and injects prelude before the user message.
  onPromptBuild(input: { sessionId: string }): Promise<BuildContextResult>;
  // After a turn completes: fire-and-forget extraction (never blocks the user stream).
  onTurnEnd(input: { sessionId: string; messages: ExtractionMessage[] }): Promise<void>;
  onSessionEnd(input: { sessionId: string }): Promise<void>;
  // Idle/scheduled consolidation trigger (gated by minHours/minSessions).
  onIdle(input?: { force?: boolean }): Promise<void>;

  // ---- Explicit host operations ----
  getContext(): Promise<BuildContextResult>;
  readMemory(relativePath: string): Promise<MemoryDocument | null>;
  saveMemory(input: { type: MemoryType; name: string; description?: string; body: string }): Promise<{ changed: string[] }>;
  runDream(opts?: { force?: boolean }): Promise<{ changed: string[]; deleted: string[] }>;
  doctor(): Promise<HealthFinding[]>;
  rebuildIndex(): Promise<string>;
}

export function createMemFlywheel(config: MemFlywheelConfig): MemFlywheel;
```

### 4.2 Hook → core mapping

| Hook | Core calls |
|---|---|
| `onSessionStart` | init cursor entry; `ensureMemoryDir` |
| `onPromptBuild` | `recall.buildContext({ root, enabled })` |
| `onTurnEnd` | `extract.runExtractionSession({ ctx, agent, messages, sessionId, cursorStore })` (skipped if no `agent`) |
| `onIdle` | gate check → `dream.runDreamSession({ ctx, runner: dreamRunner })` (deterministic pre-pass always; the subagent only if a `dreamRunner` is configured) |
| `onSessionEnd` | flush pending extraction queue |
| `saveMemory` | `memory-tools.write` handler → `index-file.syncMemoryIndex` |

> **Injection-point exposure:** the host passes `agent` and `dreamRunner` into `createMemFlywheel`. These are the *only* places an LLM enters the system. If omitted, MemFlywheel still runs (recall, the deterministic dream pre-pass, health, explicit save) — it just won't auto-extract or run the semantic dream subagent.

### 4.3 Default extraction / dream subagent factories + canonical model protocol

The SDK assembles core's default prompts + write tools into running tool-calling subagents. There is ONE provider-neutral model channel — `model` — and it drives both subagents. Provider wire shapes live in `@memflywheel/model`, not in the SDK loops.

```ts
export interface CanonicalModelCompletion {
  complete(req: CanonicalModelRequest): Promise<CanonicalModelResponse>;
}

// Drive a tool-calling loop over core's DEFAULT_EXTRACTION_SYSTEM_PROMPT + write
// tools + canonical model into a full ExtractionAgentRunner. The subagent writes
// memory files itself via the tools. Pass a custom prompt/maxSteps to override.
export function createExtractionAgentRunner(opts: {
  model: CanonicalModelCompletion; systemPrompt?: string; maxSteps?: number;
}): ExtractionAgentRunner;

// Dream consolidation subagent: DEFAULT_DREAM_SYSTEM_PROMPT + buildDreamAgentUserMessage
// over the SAME tool-calling loop. Reads full bodies, then merges/compresses/retires
// via the ordinary file tools. Same canonical model channel as extraction.
export function createDreamAgentRunner(opts: {
  model: CanonicalModelCompletion; systemPrompt?: string; maxSteps?: number;
}): DreamAgentRunner;

// Provider mapper in @memflywheel/model. Targets an OpenAI-compatible
// /chat/completions endpoint WITH a tools array. Reads endpoint / API key / model
// from the environment (MEMFLYWHEEL_LLM_*) or explicit opts.
export interface OpenAIChatCompletionsModelConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch; // injectable for tests (fake tool_calls)
}
export function createOpenAIChatCompletionsModel(
  config?: OpenAIChatCompletionsModelConfig
): CanonicalModelCompletion;
```

> **Batteries included:** `createMemFlywheel({ agent: createExtractionAgentRunner({ model: createOpenAIChatCompletionsModel() }) })` is a complete, running extraction setup given one API key in the environment. Native adapters should wrap their host's own tool-calling LLM channel into `CanonicalModelCompletion`; OpenAI-compatible HTTP is only one mapper.

---

## 5. `@memflywheel/adapters` — host lifecycle mappings

Each adapter maps a host's lifecycle events onto the SDK's `MemFlywheel` hooks. Adapters contain **no memory logic** — pure event translation.

```
adapters/src/
├── index.ts
├── adapter.ts          # shared HostAdapter contract
├── hermes.ts
├── opencode.ts
├── openclaw.ts
├── pi.ts
├── codex.ts
└── claude-code.ts
```

### 7.1 Shared contract

```ts
export interface HostAdapter {
  name: string;
  // Wire a MemFlywheel into the host's runtime; returns a disposer.
  attach(scribe: MemFlywheel, host: unknown): () => void;
}
```

### 7.2 Lifecycle mapping table (host event → scribe hook)

| Host | session start | prompt assembly | turn done | idle/scheduled |
|---|---|---|---|---|
| **Pi** | session create | `buildPiTurn`/system-prompt assembly → inject `systemPrompt` + prelude | `onTurnDone` (fire-and-forget) | learning-loop idle tick |
| **Hermes** | conversation open | pre-completion prompt hook | post-completion callback | scheduler tick |
| **OpenCode** | session init | message build middleware | response complete event | background timer |
| **OpenClaw** | agent start | system + context injection point | turn end signal | idle watcher |
| **Codex** | task start | instruction assembly | task complete | scheduled job |
| **Claude Code** | session start hook | UserPromptSubmit-style hook → prelude | Stop/turn-end hook | idle/cron |

For each: `onSessionStart` ↔ start, `onPromptBuild` (returns both segments) ↔ prompt assembly, `onTurnEnd` ↔ turn-done (async, non-blocking), `onIdle` ↔ idle/scheduled. The adapter is responsible only for (a) extracting `ExtractionMessage[]` from the host's transcript shape, (b) placing `systemPrompt`/`preludePrompt` where that host expects them (the prelude must remain `<system-reminder>`-wrapped), and (c) exposing the host's own tool-calling LLM channel as `CanonicalModelCompletion` or `HostHarnessPort` that drives both `createExtractionAgentRunner` and `createDreamAgentRunner`.

### 7.3 Default extraction-subagent wiring + install/verify

An adapter carries no memory or provider-specific LLM logic: it exposes the host's tool-calling LLM as a canonical model or `HostHarnessPort`, hands it to the SDK's `createExtractionAgentRunner({ model })` and `createDreamAgentRunner({ model })`, and attaches the resulting `MemFlywheel`. `install` plans then applies a versioned wiring marker into the host config (atomic write), and `verify` re-reads from disk to round-trip-confirm the wiring.

### 7.4 Runnable examples

The `examples/` directory holds a minimal, runnable integration per targeted host — at least OpenClaw, Hermes, and Pi. Each example exposes a canonical model or explicit recall-only mode, builds the default extraction subagent when the host is model-capable, mounts the full lifecycle (session start / prompt build / turn end / agent end / idle), and installs + verifies the wiring.

---

## 6. Storage Layout on Disk

```
<MEMFLYWHEEL_HOME or os-data>/memflywheel/memory/
├── MEMORY.md             # derived index (rebuildable)
├── .memory-task-lock     # write mutex (JSON: pid, owner, startedAt)
├── .last-extraction      # ISO timestamp
├── .audit.log            # append-only JSONL audit
├── archive/              # archived (explicitly corrected) memories
├── identity/   *.md
├── preference/ *.md
├── style/      *.md
├── workflow/   *.md
├── context/    *.md
└── ambient/    *.md
```

Memory file = frontmatter + body:

```
---
name: 用户称呼
description: 用户偏好的称呼
type: identity
retrieval_terms:
  - 用户称呼
  - preferred name
  - address user
created_at: 2026-06-15T10:30:00.000Z
updated_at: 2026-06-15T10:30:00.000Z
---

叫用户小钟。用户不喜欢被称为"阿中"。
```

---

## 7. Concurrency, Atomicity, Audit (cross-cutting)

- **Write lock** (`lock.ts`) wraps every multi-file mutation (extraction, dream-apply). Stale detection via `process.kill(pid,0)` + 180s timeout.
- **Atomic write** (`atomic.ts`): temp file in same dir → `rename`. Index sync, doc writes, lock file all atomic.
- **Audit** (`audit.ts`): every write/delete/relocate/extract/dream-apply/archive appends a JSONL record. Never contains raw secret material.

---

## 8. Privacy Pipeline (cross-cutting)

Order on any inbound body (a subagent tool write or an explicit save):
1. `redactPrivateSpans` — `<private>…</private>` → `[REDACTED]` (always on, deterministic).
2. `scanSecrets` — **optional** (`refuseSecrets` gate, default off): if a hard secret (token/password/api-key/cookie/ssh-key) survives → **refuse write**, audit a masked finding.
3. Only then `writeMemoryDocument` (the write tool's atomic write + audit + index resync).

---

## 9. Recall ↔ Extraction ↔ Dream data flow (end to end)

```
[turn N: prompt build]
  scribe.onPromptBuild → recall.buildContext
     scan → syncIndex → readIndex → truncate → aging
     ⇒ { systemPrompt(rules), preludePrompt(<system-reminder> index cues) }
  host injects both → model self-selects, optionally Reads a body

[turn N: done]  (async, never blocks)
  scribe.onTurnEnd → runExtractionSession
     lock → relocate → before-scan → select window(cursor)
     → agent({ tools, toolCtx, messages, manifest, root })   ← LLM injection point
        subagent: glob/search/read → write / edit / bash (writes files)
     → relocate → after-scan → syncIndex
     → advance cursor (success only) → stamp .last-extraction → unlock → drain

[idle/scheduled]
  scribe.onIdle → gate(minHours|minSessions|force) → runDreamSession
     lock → planDeterministic (health + dupes) → apply (delete-duplicate / relocate)
     → dreamRunner({ tools, toolCtx, health, typeReview, manifest, index, coordination })  ← LLM injection point
        subagent: read full bodies → write (merge) / edit (compress) / bash
     → relocate → after-scan → syncIndex → audit → unlock
```

---

## 10. We Deliberately Do NOT Build (do not add these back)

These are **out of scope by design** — reviewers and future contributors must not reintroduce them:

- **No scope / multi-tenancy.** No user/project/workspace tiers. Single global store. (There is no `getWorkspaceMemoryDir`; MemFlywheel is deliberately a single global store.)
- **No memory-body retrieval.** Do not embed, rank, or search memory bodies. Optional retrieval is limited to `MEMORY.md` index lines.
- **No entity index / knowledge graph.**
- **No embedded default model / reranker.** Embedding providers are host-supplied, apply only to index lines, and are skipped when the full index fits.
- **No open-ended frontmatter fields.** No `scope`, `origin`, `source_ref`, `confidence`, `status`, `agent`, `project`, `session`. Only `name` / `description` / `type`, optional `occurred_on` / `retrieval_terms`, and minimal `created_at` / `updated_at`.
- **No LLM calls inside core.** Extraction and dream semantics are pluggable injection points; core stays deterministic.
- **No runtime npm dependencies.** No YAML lib, no arg-parser lib, no protocol SDK runtime dep — hand-roll on Node stdlib.
- **MEMORY.md is never LLM-authored.** It is derived from scan and rebuilt; the model never edits it.

---

## 11. Design constants and portability notes

- `parseMemoryFrontmatter` requires `name` + `type` only; `description` defaults to `""`; `retrieval_terms` is the only supported YAML list field — reflected in `frontmatter.ts` / `MemoryEntry`.
- Locked constants: `MAX_SCAN_ENTRIES=200`, `FRONTMATTER_READ_BYTES=2048`, `INDEX_MAX_LINES=200`, `INDEX_MAX_BYTES=25000`, aging `context`/`ambient = 30d` (others `null`), `LOCK_TIMEOUT_MS=180000`, `EXTRACTION_CONTEXT_WINDOW_SIZE=6`, `EXTRACTION_MAX_MESSAGES=40`, dream `minHours=24` / `minSessions=5`.
- Two-segment injection (`buildMemoryInstructionPrompt` stable rules + `buildMemoryIndexPrompt` `<system-reminder>` prelude) lives in `recall.ts`.
- No desktop-framework coupling: root resolves via the `MEMFLYWHEEL_HOME` env or an OS data dir helper in `paths.ts` (pure Node, fully portable). The index uses relative paths.
```
