# @iflytekopensource/adapters

Host lifecycle mappings and native model bindings for MemFlywheel. Each adapter
translates host lifecycle events onto MemFlywheel hooks and resolves the host's
active model into a `pi-ai` stream. Core memory semantics remain in the bundled
MemFlywheel Core and SDK layers.

The package installs Pi Agent Core, `pi-ai`, and `proper-lockfile` as runtime
dependencies.

## Built-in adapters

| id         | host     | prompt recall                        | turn end                                      | session end        | integration |
| ---------- | -------- | ------------------------------------ | --------------------------------------------- | ------------------ | ----------- |
| `pi`       | Pi       | `context`                            | `agent_end`                                   | `session_shutdown` | real        |
| `hermes`   | Hermes   | `prefetch`                           | `sync_turn`                                   | `on_session_end`   | real        |
| `openclaw` | OpenClaw | `before_prompt_build`                | `agent_end`                                   | `session_end`      | real        |
| `opencode` | OpenCode | `experimental.chat.system.transform` | `experimental.text.complete` / `session.idle` | `session.deleted`  | real        |

`@iflytekopensource/adapters` owns the shared host adapter/runtime layer. Host-specific
install shape still differs: Pi, OpenCode, and OpenClaw can load package
entrypoints directly, while Hermes needs the `@iflytekopensource/hermes` package to
install its Python `MemoryProvider`, config wiring, and skill mirror.

- **`pi`** — real: `@iflytekopensource/adapters` is a Pi package. Its
  `package.json` declares `pi.extensions`, and Pi installs it with
  `pi install npm:@iflytekopensource/adapters`.
  `context` → `onPromptBuild`; `agent_end` → `onTurnEnd`; and
  `session_shutdown` → `onSessionEnd`.
- **`hermes`** — real: `@iflytekopensource/hermes` installs a Hermes
  `MemoryProvider`, and its bridge imports `@iflytekopensource/adapters` for the
  shared runtime. `prefetch` builds recall context, `sync_turn` runs the
  write-side lifecycle, and session end coordinates idle consolidation.

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

An adapter contains no memory loop. It resolves the host's active model into a
pi-ai `Model` + `StreamFn` and exposes lifecycle events through `HostHarnessPort`.
`createMemFlywheelHarnessRuntime` then builds Extraction, Dream, and Skill
Evolution on the single Pi Agent Core runner.

```ts
import { createMemFlywheelHarnessRuntime } from "@iflytekopensource/adapters";

const { scribe, sdk } = createMemFlywheelHarnessRuntime({ port });
```

Pi phase-1 native integration uses a host port:

```ts
import { createMemFlywheelHarnessRuntime, createPiHarnessPort } from "@iflytekopensource/adapters";
import { streamSimple } from "@earendil-works/pi-ai/compat";

export default function memFlywheelExtension(pi) {
  const port = createPiHarnessPort(pi, { streamSimple });
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
export MEMFLYWHEEL_EMBEDDING_ENDPOINT="https://embedding-gateway.example.com/v1"
export MEMFLYWHEEL_EMBEDDING_API_KEY="..."
export MEMFLYWHEEL_EMBEDDING_MODEL="text-embedding-3-small"
export MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL="auto"
```

`MEMFLYWHEEL_EMBEDDING_API_KEY` is sent as a Bearer token. For proxy or gateway
deployments, set `MEMFLYWHEEL_EMBEDDING_ENDPOINT` to the OpenAI-compatible
gateway URL; provider-specific auth and routing stay in that gateway or in a
custom `memoryIndexRetrieval.embeddingProvider`.

Use `MEMFLYWHEEL_MEMORY_INDEX_RETRIEVAL=required` while testing if a missing or
broken embedding provider should fail prompt build instead of using direct index
injection.

Custom hosts can either pass custom lifecycle hooks or ask
`createMemFlywheelHarnessRuntime` to assemble the bundled file-native
learned-skill store:

```ts
const { scribe } = createMemFlywheelHarnessRuntime({
  port,
  learnedSkills: {
    skillsRoot: "/path/to/skills",
    checkpointRoot: "/path/to/.skill-checkpoints",
  },
  learningLoop: {
    gate: { minDoneTurns: 3, cooldownTurns: 2, minToolCalls: 6 },
  },
});
```

- With `resolveModel` or `port`: real semantic extraction AND dream consolidation run
  as tool-calling subagents on the **host's own model**, writing memory files directly.
- With `learnedSkills`: the bridge creates a learned-skill store, recall
  provider, and `runSkillEvolutionAgent`; turn-end can run extraction -> skill
  evolution -> dream, and the next prompt sees the learned-skill route.
- With `skillRecall` / `skillPreludeBuilder`: prompt build appends learned-skill
  routes through the same SDK prompt context.
- With custom `learningLoop.skillEvolution`: hosts may replace the default
  learned-skill runner while keeping SDK gate/dream coordination.
- Without `resolveModel`/`port` and without an explicit `agent`: construction fails
  unless `mode: "recall-only"` is set explicitly. Recall-only injects memory on
  prompt build, turns never extract, and dream runs only its deterministic structural pre-pass.
- The adapter-facing `onSessionEnd` runs a final agent-end sweep (extracting any
  not-yet-processed messages) before dropping the session.

Hosts with no in-process model-call API must either run recall-only or expose a
real pi-ai stream through a sidecar/upstream host API. MemFlywheel does not parse
text as fake tool calls.

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
