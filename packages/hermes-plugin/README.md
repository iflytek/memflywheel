# MemFlywheel Hermes Plugin

Installs MemFlywheel as a Hermes `MemoryProvider`.

## Install From npm

```bash
npm install -g @iflytekopensource/hermes
memflywheel-hermes-install
hermes config set memory.provider memflywheel
hermes memory status
```

Then start Hermes normally:

```bash
hermes --tui
```

MemFlywheel uses Hermes' own model, authentication, lifecycle, and tool
execution policy. It does not expose a memory recall tool to the main model.

Default behavior: file-native recall, turn-end extraction, session-end dream
cleanup, secret refusal, and learned-skill evolution are enabled. Set
`MEMFLYWHEEL_LEARNED_SKILLS=false` or configure `learned_skills=false` only when
you need to disable skill learning explicitly.

## What The Installer Does

`memflywheel-hermes-install` installs the provider into:

```text
$HERMES_HOME/plugins/memflywheel
```

If `HERMES_HOME` is unset, Hermes' default home is used:

```text
~/.hermes/plugins/memflywheel
```

The installer also:

| Step                       | Effect                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| Copy provider files        | Installs `__init__.py`, `worker.mjs`, and `plugin.yaml`             |
| Pin adapter import         | Writes `install.json` so the worker loads the npm-installed adapter |
| Disable native memory tool | Adds `memory` to `agent.disabled_toolsets`                          |
| Preserve old native memory | Moves `memories/MEMORY.md` to `memories.disabled-by-memflywheel/`   |

## Runtime Files

MemFlywheel stores memory under `$MEMFLYWHEEL_HOME` when set. Otherwise it uses:

```text
$HERMES_HOME/memflywheel
```

Common paths:

```text
~/.hermes/memflywheel/MEMORY.md
~/.hermes/memflywheel/preference/*.md
~/.hermes/memflywheel/workflow/*.md
~/.hermes/memflywheel/.memflywheel/sources/*.jsonl
~/.hermes/memflywheel/learned-skills/*/SKILL.md
~/.hermes/skills/memflywheel/*/SKILL.md
```

The last path is the Hermes-native skill mirror. MemFlywheel learns skills in its
own store, then mirrors them into Hermes' skill ecosystem.

## Flow

```text
Hermes prompt build
   |
   v
MemFlywheel prefetch -> MEMORY.md cues + learned-skill routes
   |
   v
Hermes main model runs normally
   |
   v
Hermes turn end
   |
   v
MemFlywheel extraction -> source trace -> skill evolution -> dream
   |
   v
Hermes skill mirror sync
```

Hermes owns the user-facing Agent. MemFlywheel only owns the file-native memory
and learning loop.

## Verify

```bash
hermes plugins list | grep memflywheel
hermes memory status
find ~/.hermes/memflywheel -maxdepth 3 -print
find ~/.hermes/skills/memflywheel -maxdepth 3 -print
```

After a real session, expect memory files under `~/.hermes/memflywheel` and
learned-skill mirrors under `~/.hermes/skills/memflywheel`.

## Source Checkout

```bash
pnpm --filter @iflytekopensource/hermes run build
pnpm --filter @iflytekopensource/hermes run install:local
hermes config set memory.provider memflywheel
```

This is equivalent to the npm path above, except the installer is executed from
the source checkout instead of the globally installed package.
