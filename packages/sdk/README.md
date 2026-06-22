# @memscribe/sdk

Host lifecycle integration layer for [MemScribe](https://github.com/iflytek/memscribe#readme). The thin
orchestration seam between a host runtime (Pi / Claude Code / OpenCode / …) and
`@memscribe/core`.

The SDK owns:

- a single per-root `StorageContext` + audit logger,
- the per-session extraction cursor store,
- the **two pluggable LLM injection points** (`agent`, `dreamRunner`),
- the default subagent loops that consume `@memscribe/model`'s canonical model protocol,
- optional learned-skill prompt routing,
- the host lifecycle hooks that decide *when* core runs.

The SDK does not execute learned skills. It can expose routing metadata and
capture tool-call facts in the session transcript, while the host owns skill
loading, execution policy, permissions, and tool calls.

The SDK orchestrates after-turn extraction; the actual LLM work is externalized
to an `ExtractionAgentRunner` — a tool-calling subagent that writes the memory
files itself through ordinary file tools. That agent can be the built-in default
(see below) or host-supplied. Zero runtime dependencies.

## Default extraction + dream subagents (batteries included)

You do not have to write the prompts or wire the tool loop. The core ships a
curated default extraction system prompt and a default dream consolidation system
prompt, plus ordinary file tools (`read` / `write` / `edit` / `bash` /
`glob` / `grep`) as **pure values** — it never
makes a network call. The SDK assembles them into running tool-calling subagents
over one provider-neutral model channel. There is ONE model channel — `model` —
and it drives both subagents:

```ts
import {
  createMemScribe,
  createExtractionAgentRunner,
  createDreamAgentRunner,
} from "@memscribe/sdk";
import { createOpenAIChatCompletionsModel } from "@memscribe/model";

// The OpenAI-compatible mapper lives in @memscribe/model. Hosts can provide
// their own CanonicalModelCompletion instead.
const model = createOpenAIChatCompletionsModel();
const scribe = createMemScribe({
  agent: createExtractionAgentRunner({ model }),
  dreamRunner: createDreamAgentRunner({ model }),
});
```

Pass your own `CanonicalModelCompletion` to route through a host's existing LLM
channel, or pass a fully custom `ExtractionAgentRunner` / `DreamAgentRunner` to
replace the defaults.

## Quick start

```ts
import { createMemScribe, type ExtractionAgentRunner } from "@memscribe/sdk";

// Host wraps its own tool-calling LLM here. Core never calls a model; the
// subagent writes memories itself via the supplied tools.
const agent: ExtractionAgentRunner = async ({ tools, toolCtx, messages, manifest, root }) => {
  // …drive your tool-calling model with `tools` (read / write / edit / bash /
  //   glob / grep), given `messages` + `manifest`; each call
  //   writes a file via tools[i].handler(args, toolCtx)…
  return { changed: ["preference/favorite-fruit.md"] };
};

const scribe = createMemScribe({ agent }); // root resolves from MEMSCRIBE_HOME / OS data dir

await scribe.onSessionStart("session-1");

// At prompt assembly time — two recall segments:
const { systemPrompt, preludePrompt } = await scribe.onPromptBuild("session-1");
//  systemPrompt  → STABLE memory rules (cache-friendly prefix)
//  preludePrompt → DYNAMIC full MEMORY.md index, wrapped in <system-reminder>

// After each turn, hand the SDK the turn's messages; it runs extraction:
await scribe.onTurnEnd("session-1", [
  { role: "user", text: "记住：我喜欢草莓" },
  { role: "assistant", text: "好的" },
]);

await scribe.onSessionEnd("session-1");
```

## Prompt recall

`onPromptBuild()` returns `{ systemPrompt, preludePrompt, enabled, skillPreludePrompt? }`:

| Segment | Content | Cadence |
| --- | --- | --- |
| `systemPrompt` | Stable memory **rules** — constant text, identical every turn | inject once / cache as a stable prefix |
| `preludePrompt` | **Full MEMORY.md index** plus optional learned-skill routes wrapped in `<system-reminder>` | inject every turn |
| `skillPreludePrompt` | Optional learned-skill route index | inject when `skillRecall` is configured |

There is no retrieval, top-k, scoring, or embedding. The full index is injected
and the main model self-selects whether to use the host's normal Read/file tool
for any memory body.

When `skillRecall` is configured, the SDK also injects learned-skill routing
metadata. The host still owns actual skill loading and execution.

## The two pluggable LLM injection points

Both are optional. Core/SDK own timing, locking, atomic writes, index sync, and
the cursor; the host owns only the LLM call.

```ts
// 1) Extraction — a tool-calling subagent that WRITES the memory files itself.
type ExtractionAgentRunner = (input: {
  toolCtx: FileToolContext;     // bound inside the held write lock
  tools: FileTool[];            // read / write / edit / bash / glob / grep
  messages: { role: "user" | "assistant"; text: string }[];
  manifest: string;   // formatManifest(existing entries)
  root: string;
}) => Promise<{ changed: string[] }>;   // the relative paths it touched

// 2) Dream — the SAME kind of tool-calling subagent, seeded for consolidation. It
//    reads full bodies and merges / compresses / retires memories via the tools.
type DreamAgentRunner = (input: {
  root: string;
  toolCtx: FileToolContext;     // bound inside the held write lock
  tools: FileTool[];            // same ordinary file tools as extraction
  health: HealthFinding[];
  typeReview: TypeReviewItem[];
  manifest: string;
  index: string;
  coordination?: { reason: string; memoryAction: string; topics: string[]; targetSkill?: string };
}) => Promise<{ changed: string[] }>;   // the relative paths it touched
```

Each subagent decides add vs. update on its own — it can call `glob` / `grep`
to locate, `read` to load a full body, then `write` for a new typed Markdown
file, `edit` to refine a same-topic file, or `bash` to move retired files under
`.archive/` before writing the replacement.

## Lifecycle hooks

| Hook | When the host calls it | What the scribe does |
| --- | --- | --- |
| `onSessionStart(id)` | session opens | ensure memory dir, register session state |
| `onTurnStart(id)` | new turn begins | register session state |
| `onPromptBuild(id?)` | assembling the prompt | return the two recall segments |
| `onTurnEnd(id, msgs)` | turn finished | append turn -> run extraction; with an opt-in `learningLoop`, host/adapters can also run skill evolution and forced dream coordination |
| `onSessionEnd(id)` | session closes | drop session state |
| `onAgentEnd(id)` | auxiliary/agent run ends | final extraction sweep over not-yet-processed messages |
| `onIdle(gate?)` | idle / scheduled | gate-check then `runDreamSession`: deterministic pre-pass, then the consolidation subagent via `dreamRunner` |

### Explicit operations (for MCP tools / CLI)

- `context()` — the full-index prelude + stable rules.
- `save(options)` — explicit validated typed Markdown write under the lock, then
  index sync.
- `runDream(coordination?)` — force a dream pass regardless of the gate.

There is deliberately **no public read/search tool** — MemScribe has no lexical retrieval,
and recall reads go through the host filesystem surface.
CLI and MCP remain memory-facing surfaces by default. They do not inject learned
skills or execute skills unless a future host explicitly adds that surface.

## Skill learning loop

The SDK exposes primitives and opt-in hooks without becoming a full agent
framework. Host/adapters can assemble the loop:

```text
prompt-build
  -> memory recall
  -> learned skill routes

turn-end
  -> extraction
  -> skillEvolution({ lastExtraction, session })
  -> dream({ memoryAction: "compress-memory", topics }) when derived or custom coordination requests memory compression
```

```ts
createMemScribe({
  agent,
  dreamRunner,
  skillRecall: async ({ sessionId }) => ({
    entries: [
      {
        name: "memscribe-learned-release-review",
        displayName: "Release Review",
        description: "Review release readiness with a repeatable checklist.",
        relativePath: "memscribe-learned-release-review/SKILL.md",
        triggerHints: ["release prep"],
      },
    ],
  }),
  learningLoop: {
    source: "local",
    skillLearningEnabled: true,
    skillEvolution: async ({ lastExtraction, session }) => {
      // Custom SDK hook; adapters can also assemble this with learnedSkills.
      return {
        coordination: {
          decision: "update",
          targetSkill: "memscribe-learned-release-review",
          mergedSkills: [],
          why: "Release prep became a reusable procedure.",
          memoryAction: "compress-memory",
          memoryTopics: ["release prep"],
          supportingFiles: ["memscribe-learned-release-review/SKILL.md"],
        },
        changedSkills: ["memscribe-learned-release-review"],
        changedFiles: ["memscribe-learned-release-review/SKILL.md"],
      };
    },
  },
});
```

If `toolCalls` and `turnsSinceLastSkillEvolution` are omitted, the SDK counts
captured `ExtractionMessage.toolCalls` and tracks the last skill-evolution turn
per session. Skill evolution runs only after extraction returns `Completed`;
skipped or failed extraction returns `extraction-not-completed`.

## After-turn extraction semantics

`onTurnEnd` / `onAgentEnd` delegate to core's `runExtractionSession`, which owns
the full lifecycle:

1. acquire the per-root write lock (else the run is enqueued → `Queued`)
2. relocate stray root-level files into their typed dirs
3. before-scan → manifest
4. select the cursor window over cleaned messages (`<system-reminder>` blocks and
   prelude text stripped from user turns; assistant turns kept verbatim)
5. build the bound tools + context (sharing the held lock) and `await agent(...)`,
   which drives the subagent; the subagent writes via the tools (each handler:
   path-safety check → atomic write → audit append → index resync)
6. relocate again → after-scan → sync `MEMORY.md`
7. advance the cursor **only on success**; stamp `.last-extraction`
8. release the lock, drain the pending queue

The agent throwing yields `Failed` and advances nothing (a later turn retries the
same window).

## Configuration

```ts
createMemScribe({
  root?: string,            // override; else MEMSCRIBE_HOME / OS data dir
  enabled?: boolean,        // false ⇒ all hooks are no-ops
  agent?: ExtractionAgentRunner, // injection point #1 (absent ⇒ extraction skipped)
  dreamRunner?: DreamAgentRunner, // injection point #2 (absent ⇒ deterministic pre-pass only)
  refuseSecrets?: boolean,  // optional hard-secret gate (default off; <private> redaction always on)
  audit?: AuditLogger,      // default: file-backed at <root>/.audit.log
  cursorStore?: CursorStore, // default: in-memory
  skillRecall?: SkillRecallProvider,
  skillPreludeBuilder?: SkillPreludeBuilder,
  learningLoop?: MemScribeLearningLoopConfig,
});
```

## Build & test

```bash
pnpm --filter @memscribe/sdk build
pnpm --filter @memscribe/sdk test   # node:test, tsc-compiled
```
