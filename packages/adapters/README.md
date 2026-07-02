# @iflytekopensource/adapters

Host lifecycle mappings for MemFlywheel. Each adapter translates a host's lifecycle
events — session start, prompt assembly, turn end, idle/scheduled — onto a
`MemFlywheel`'s hooks. Adapters contain **no memory logic**: they are pure event
translation plus a real, round-trippable install of the host-side wiring.

Zero runtime dependencies (Node stdlib + TypeScript only).

## Built-in adapters

| id         | host      | session start        | prompt build     | turn end            | idle/scheduled     | integration |
| ---------- | --------- | -------------------- | ---------------- | ------------------- | ------------------ | ----------- |
| `pi`       | Pi kernel | `session:ensure`     | `turn:build`     | `agent_end`         | `learning:idle`    | real        |
| `hermes`   | Hermes    | `on_session_start`   | `pre_llm_call`   | `post_llm_call`     | `on_session_end`   | real        |
| `openclaw` | OpenClaw  | `before_agent_start` | `context:inject` | `agent_end`         | `idle:watch`       | real        |
| `opencode` | OpenCode  | `session.init`       | `message.build`  | `response.complete` | `timer.background` | real        |

`@iflytekopensource/adapters` owns the shared host adapter/runtime layer. Host-specific
install shape still differs: Pi, OpenCode, and OpenClaw can load package
entrypoints directly, while Hermes needs the `@iflytekopensource/hermes` package to
install its Python `MemoryProvider`, config wiring, and skill mirror.

- **`pi`** — real: `@iflytekopensource/adapters` is a Pi package. Its
  `package.json` declares `pi.extensions`, and Pi installs it with
  `pi install npm:@iflytekopensource/adapters`.
  `session:ensure` → `onSessionStart`; per-turn assembly → `onPromptBuild` (the
  scribe's `systemPrompt` merges into the per-session system prompt and
  `preludePrompt` is prepended to the prelude list); `agent_end` →
  `onTurnEnd` (fire-and-forget); learning-loop idle tick → `onIdle`.
- **`hermes`** — real: `@iflytekopensource/hermes` installs a Hermes
  `MemoryProvider`, and its bridge imports `@iflytekopensource/adapters` for the
  shared runtime. `on_session_start` → `onSessionStart`; `pre_llm_call` →
  `onPromptBuild` (inject prelude as `{"context": ...}`); `post_llm_call` →
  `onTurnEnd` (reads `user_message` + `assistant_response`, or an explicit
  `transcript`); `on_session_end` → `onIdle`.

Each adapter declares a `defaultConfigRelPath` (the host config under `$HOME`) and
an `integrationNote` describing how the host actually consumes the scribe.

## The `HostAdapter` contract

```ts
interface HostAdapter {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: LifecycleMap; // host event → scribe hook, per hook

  attach(scribe: MemFlywheel, host: HostRuntime): () => void; // wire events, returns disposer
  install(target: InstallTarget, opts?: { apply?: boolean }): Promise<InstallPlan | InstallResult>;
  verify(target: InstallTarget): Promise<VerifyResult>; // real round-trip from disk
  doctor(target: InstallTarget): Promise<DoctorFinding[]>;
}
```

### attach — pure event translation

`attach` binds each host event to the matching scribe hook and returns a disposer
that removes every listener. The `MemFlywheel` interface is structural: any
object with the lifecycle hooks satisfies it, including the runtime assembled by
`createMemFlywheelHarnessRuntime(...)`.

```ts
import { piAdapter } from "@iflytekopensource/adapters";

const dispose = piAdapter.attach(scribe, host);
// ... later
dispose();
```

- `onTurnEnd` is fire-and-forget: a rejecting extractor never blocks or throws
  into the host's stream.
- `onPromptBuild` returns the two recall segments (`systemPrompt`,
  `preludePrompt`). Hosts that need the result attach a `respond` callback to the
  emitted payload; the adapter delivers the `Promise<MemFlywheelContext>` to it.

### install — plan / apply (never "write and hope")

Install always **plans first**. The plan is a pure read that reports the steps it
would take and whether the on-disk wiring is already current (`satisfied`).
Passing `{ apply: true }` then merges a versioned wiring marker into the host
config and writes it atomically (temp file + rename), preserving all other keys.

```ts
const plan = await piAdapter.install({ configPath }); // no writes
if (!plan.satisfied) {
  await piAdapter.install({ configPath }, { apply: true });
}
```

Apply is idempotent: re-applying current wiring writes nothing. Stale (older
version) or corrupt configs are detected and rewritten.

### verify — real round-trip

`verify` re-reads the host config **from disk** and confirms the wiring marker is
present, belongs to this adapter, matches the current version, and has the exact
expected bindings. It never reports success from an in-memory write — a
post-install tamper is caught.

```ts
const v = await piAdapter.verify({ configPath });
if (!v.ok) console.error(v.problems);
```

### doctor — diagnose installed state

```ts
for (const f of await piAdapter.doctor({ configPath })) {
  console.log(f.code, f.message); // not-installed | stale-wiring | corrupt-config | ok
}
```

## Custom adapters

Build one from a lifecycle map + payload translators with `makeAdapter`:

```ts
import { makeAdapter, normalizeMessages, readString } from "@iflytekopensource/adapters";

export const myAdapter = makeAdapter({
  id: "my-host",
  name: "My Host",
  lifecycle: {
    onSessionStart: { hook: "onSessionStart", hostEvent: "start", note: "..." },
    onPromptBuild: { hook: "onPromptBuild", hostEvent: "build", note: "..." },
    onTurnEnd: { hook: "onTurnEnd", hostEvent: "done", note: "..." },
    onIdle: { hook: "onIdle", hostEvent: "idle", note: "..." },
  },
  translators: {
    sessionId: (p) => readString(p, "sessionId"),
    turnEnd: (p) => ({
      sessionId: readString(p, "sessionId"),
      messages: normalizeMessages((p as { messages?: unknown }).messages),
    }),
  },
});
```

Install/verify/doctor come for free.

## Direct integration: `createMemFlywheelHarnessRuntime`

An adapter contains no memory or provider-specific LLM logic. To make a host
work out of the box, expose a host-owned `CanonicalModelCompletion` or a
`HostHarnessPort` and pass it to `createMemFlywheelHarnessRuntime`. That builds
the SDK default extraction AND dream consolidation subagents (default prompts +
ordinary file tools) on top of the single canonical model channel, assembles a real
`createMemFlywheel`, and returns an adapter-ready `MemFlywheel` plus the underlying
SDK scribe for explicit ops. One channel drives both subagents:

```ts
import { createMemFlywheelHarnessRuntime, hermesAdapter } from "@iflytekopensource/adapters";

// Host-owned model channel. The host owns auth, transport, policy, and lifecycle.
const model = {
  complete: (req) => ctx.llm.completeWithTools(req),
};

const { scribe, sdk } = createMemFlywheelHarnessRuntime({ model });
const dispose = hermesAdapter.attach(scribe, host); // session/prompt/turn-end/idle
```

Pi phase-1 native integration uses a host port:

```ts
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "@iflytekopensource/adapters";
import { completeSimple } from "@earendil-works/pi-ai/compat";

export default function memFlywheelExtension(pi) {
  const port = createPiHarnessPort(pi, { completeSimple });
  const runtime = createMemFlywheelHarnessRuntime({ port });
  return runtime.dispose;
}
```

The packaged Pi extension enables learned skills by default. It stores
MemFlywheel state under `$MEMFLYWHEEL_HOME` when set, otherwise
`~/.pi/agent/memflywheel`, and mirrors finalized learned skills into Pi's native
`~/.pi/agent/skills/memflywheel/` tree. Pi then lists them through its ordinary
skills loader and renders them in the host-native `<available_skills>` prompt
surface.

Large memory stores need embedding pre-recall after the generated `MEMORY.md`
index grows beyond the direct prompt budget (200 lines / 25 000 bytes). When
`memoryIndexRetrieval` is not supplied explicitly, the runtime auto-enables
index-layer retrieval from OpenAI-compatible embedding env:

```sh
export MEMFLYWHEEL_EMBEDDING_ENDPOINT="http://127.0.0.1:18088/v1"
export MEMFLYWHEEL_EMBEDDING_API_KEY="local"
export MEMFLYWHEEL_EMBEDDING_MODEL="BAAI/bge-m3"
export MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL="auto"
```

Use `MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL=required` while testing if a missing or
broken embedding provider should fail prompt build instead of using direct index
injection.

Custom hosts can either pass custom lifecycle hooks or ask
`createMemFlywheelHarnessRuntime` to assemble the bundled file-native
learned-skill store:

```ts
const { scribe } = createMemFlywheelHarnessRuntime({
  model,
  learnedSkills: {
    skillsRoot: "/path/to/skills",
    checkpointRoot: "/path/to/.skill-checkpoints",
  },
  learningLoop: {
    gate: { minDoneTurns: 3, cooldownTurns: 2, minToolCalls: 6 },
  },
});
```

- With `model` or `port`: real semantic extraction AND dream consolidation run
  as tool-calling subagents on the **host's own model**, writing memory files directly.
- With `learnedSkills`: the bridge creates a learned-skill store, recall
  provider, and `runSkillEvolutionAgent`; turn-end can run extraction -> skill
  evolution -> dream, and the next prompt sees the learned-skill route.
- With `skillRecall` / `skillPreludeBuilder`: prompt build appends learned-skill
  routes through the same SDK prompt context.
- With custom `learningLoop.skillEvolution`: hosts may replace the default
  learned-skill runner while keeping SDK gate/dream coordination.
- Without `model`/`port` and without an explicit `agent`: construction fails
  unless `mode: "recall-only"` is set explicitly. Recall-only injects memory on
  prompt build, turns never extract, and dream runs only its deterministic structural pre-pass.
- The adapter-facing `onSessionEnd` runs a final agent-end sweep (extracting any
  not-yet-processed messages) before dropping the session.

Hosts with no in-process model-call API (for example a hook-only plugin surface)
must either run recall-only or expose a real canonical model port through a
sidecar/upstream host API. MemFlywheel does not parse text as fake tool calls.

```ts
const { scribe } = createMemFlywheelHarnessRuntime({ mode: "recall-only" });
```

## Connect: install + round-trip verify in one call

`connect` resolves the target (an explicit path or the adapter's
`defaultConfigRelPath` under `$HOME`), plans the wiring, and — with `apply` —
applies it and immediately re-reads from disk to verify the marker round-trips:

```ts
import { connect, piAdapter } from "@iflytekopensource/adapters";

const plan = await connect(piAdapter); // plan only, no writes
const res = await connect(piAdapter, { apply: true }); // write + verify
if (!res.verify!.ok) console.error(res.verify!.problems);
```

Runnable integration examples live under [`examples/`](https://github.com/iflytek/memflywheel/tree/main/examples).
Pi, Hermes, OpenCode, and OpenClaw are the public first-class host paths.
Host setup, embedding pre-recall, verification, and troubleshooting live in
[`docs/integrations.md`](https://github.com/iflytek/memflywheel/blob/main/docs/integrations.md).
