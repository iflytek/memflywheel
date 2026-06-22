# Extraction

Extraction is the after-turn path that turns a conversation into durable memory. The core
owns the entire mechanism — locking, message windowing, cursors, relocation, index sync — and
reaches the model only through one injected function: the `ExtractionAgentRunner`. **The core
never calls an LLM.** Instead of returning candidate JSON for the core to validate and write,
the runner drives a tool-calling subagent that **writes the memory files itself** through
core-provided write tools.

## The pluggable agent runner

```ts
type ExtractionAgentRunner = (input: {
  toolCtx: FileToolContext;     // bound to the held write lock
  tools: FileTool[];            // read / write / edit / bash / glob / grep
  messages: ExtractionMessage[];  // cleaned, windowed recent turns
  manifest: string;               // formatted list of existing memories
  root: string;                   // the memory root
}) => Promise<{ changed: string[] }>;
```

The runner wraps a tool-calling LLM. It is handed the ordinary file tools (already bound to the
context inside the held write lock) plus the windowed conversation and the existing-memory
manifest, and it returns the relative paths it touched. Returning `{ changed: [] }` is normal
and means "nothing to extract this turn."

You do not have to build that loop yourself. MemScribe ships a complete default agent (see
below); the contract above is the seam that lets you replace it.

```ts
interface ExtractionMessage {
  role: "user" | "assistant";
  text: string;
}
```

## The ordinary file tools (core)

Core exposes the write surface the subagent drives, via `createFileTools()`. Each tool is a
JSON-schema-described function with a handler that does path-safety validation, an atomic
write, an audit append, and an index resync:

- **`glob`** — list existing memories so the subagent can decide add vs update.
- **`grep`** — search existing memories by keyword over name / description / body.
- **`read`** — read one memory's full current body before merging or appending.
- **`write`** — create or overwrite one typed Markdown file with full YAML frontmatter.
- **`edit`** — exact string replacement in an existing memory file.
- **`bash`** — archive corrected/retracted files by moving them under `.archive/`.

A handler never throws for a recoverable problem; it returns `{ ok: false, text }` so the
subagent can read the failure and adjust.

## The default extraction subagent (batteries included)

The "what is worth remembering" judgment is shipped, not stubbed. MemScribe provides it in two
layers so the core stays mechanical:

- **In the core (pure values, no network).** A curated default extraction **system prompt** —
  a plain string constant (`DEFAULT_EXTRACTION_SYSTEM_PROMPT`) — and a helper
  (`buildExtractionAgentUserMessage`) that renders the conversation window and manifest into
  the seed user message. The prompt encodes:
  - what is worth remembering long-term, and what is **not** (one-off questions, transient or
    temporary state, anything with an explicit time boundary);
  - high-risk private content that must never be extracted (national IDs, bank-card numbers,
    tokens/keys, medical details, income, third-party private data);
  - the six memory types (`identity` · `preference` · `style` · `workflow` · `context` ·
    `ambient`) with definitions;
  - positive and negative examples, and the instruction to **write with the tools** (first
    `glob` / `grep` / `read`, then `write` /
    `edit` / `bash`) rather than to return JSON.

  The core never makes an LLM call — it owns the prompt string, the user-message builder, and
  the write tools.

- **In the SDK (assembles a running agent).** `createExtractionAgentRunner({ model })`
  composes the default prompt, the seed message, the advertised tools, and a canonical
  tool-calling model channel into a full `ExtractionAgentRunner`. The channel is provider-neutral:

  ```ts
  interface CanonicalModelCompletion {
    complete(req: CanonicalModelRequest): Promise<CanonicalModelResponse>;
  }
  ```

  The OpenAI-compatible mapper lives in `@memscribe/model` as
  `createOpenAIChatCompletionsModel()`. It uses Node's global `fetch` to call a
  `/chat/completions` endpoint with a `tools` array, reading endpoint / model / API key from
  `MEMSCRIBE_LLM_*`. Hosts can instead supply their own `CanonicalModelCompletion`.

  ```ts
  import { createExtractionAgentRunner } from "@memscribe/sdk";
  import { createOpenAIChatCompletionsModel } from "@memscribe/model";

  const agent = createExtractionAgentRunner({
    model: createOpenAIChatCompletionsModel(),
  });
  ```

  To route through a host's existing LLM channel, pass your own `CanonicalModelCompletion`.
  To replace the judgment entirely, pass a custom `ExtractionAgentRunner` straight to the
  core / SDK.

## The agent loop

`runExtractionAgent({ model, tools, toolCtx, messages, manifest, maxSteps })` drives the subagent:

1. Seed the conversation with the system prompt and a user message rendering the window +
   manifest, advertising the six ordinary file tools.
2. Each round, call the model. If it requests tool calls, execute each handler (which **writes
   files**) and feed the result back as a `role: "tool"` message; then loop.
3. Stop when the model requests no tools (`no-tool-calls`) or `maxSteps` (default 6) is reached.

The loop never throws for tool errors — handlers return `{ ok: false }` results the subagent
can read. Only a thrown canonical model call (for example a network failure) propagates,
which the core session treats as `Failed`.

## ADD-or-update, by the subagent

The subagent decides whether to add a new memory or refine an existing one — it can call
`glob` / `grep` first, `read` before changing any existing file, then `write`
for a new fact, `edit` to refine a same-topic file, or `bash` to archive on an
explicit user correction.

## The run

`runExtraction({ ctx, agent, messages, sessionId, cursorStore })` performs the full flow:

1. **Lock.** Acquire the per-root write lock. If it is held, the run is enqueued and returns
   `Queued`; the holder drains the queue on release.
2. **Relocate.** Move any stray valid memory files at the root into their typed directories.
3. **Snapshot + manifest.** Scan existing memories and format the manifest passed to the
   subagent.
4. **Window.** Clean the messages and select the window against the session cursor.
5. **Run the subagent.** Build the bound tools + context (sharing the held lock) and `await`
   the `ExtractionAgentRunner`, which writes via the tools. If it throws, the run returns
   `Failed` and the cursor is *not* advanced (so the same window is retried next time).
6. **Relocate again, then sync.** Re-relocate stray files, rescan, and `syncMemoryIndex`.
7. **Advance cursor + stamp.** Advance the cursor only on success and write `.last-extraction`.
8. **Release + drain.** Release the lock and drain any queued runs.

The result is one of `Queued` / `Completed` / `Skipped` / `Failed`.

## Message cleaning and windowing

Before the subagent sees them, messages are cleaned and windowed:

- **Cleaning.** User turns have any `<system-reminder>…</system-reminder>` blocks stripped
  (so the recall prelude does not leak back into extraction) and prelude-shaped boilerplate
  dropped; empty user turns are removed. Assistant turns are kept verbatim.
- **Windowing.** `selectMessagesForExtraction` selects against the per-session cursor: with no
  cursor it takes the most recent `EXTRACTION_MAX_MESSAGES` (40); otherwise it takes the new
  messages after the cursor, padding with up to `EXTRACTION_CONTEXT_WINDOW_SIZE` (6) preceding
  messages for context, capped at 40.

## Cursors

A `CursorStore` tracks the last processed message per session so extraction never reprocesses
the same turns. `createMemoryCursorStore()` is an in-memory implementation; a host can supply
its own. The cursor advances **only on a successful run** — a failed subagent run leaves it in
place so the window is retried.

## Privacy and atomic writes

Each write tool routes through the storage layer, which applies, in order:

- **Privacy.** `<private>…</private>` spans are redacted to `[REDACTED]` — always on,
  deterministic. Hard secret refusal is an **optional gate** (`refuseSecrets`, default off):
  privacy leans on the extraction prompt. With the gate
  on, a write containing an obvious secret (SSH/PEM key, API-key or token prefix, bearer/JWT
  token, `password:`/`cookie:` assignment) is refused — the write does not happen and the raw
  secret is never persisted or logged.
- **Atomic write.** Temp file + `rename`.
- **Audit.** The action is appended to `.audit.log`.

## Relocation

If the subagent (or anything else) leaves a valid memory file at the root instead of under its
typed directory, `relocateRootFiles` moves it into `<type>/` based on the file's own
frontmatter `type`. This runs both before and after the extract step so the store stays
canonical.
