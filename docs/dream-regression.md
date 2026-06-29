# Dream consolidation — real-model regression

A live run of the dream consolidation subagent against a real OpenAI-compatible
tool-calling model. It confirms the two-phase design end to end: a
deterministic, LLM-free structural pre-pass, then a tool-calling subagent that
**reads full bodies before merging** and consolidates by calling the ordinary file tools
directly.

Reproduce with `examples/dream-regression.mjs` (env-driven, no hardcoded secrets):

```
MEMFLYWHEEL_LLM_ENDPOINT=<your OpenAI-compatible base> \
MEMFLYWHEEL_LLM_MODEL=<model id> \
MEMFLYWHEEL_LLM_API_KEY=<your key> \
node examples/dream-regression.mjs
```

## Seed: a realistic, messy store

| Path                                  | Type       | Why it's there                                     |
| ------------------------------------- | ---------- | -------------------------------------------------- |
| `identity/role.md`                    | identity   | stable identity — should be left alone             |
| `preference/tea.md`                   | preference | beverage pref #1 (green tea)                       |
| `preference/coffee.md`                | preference | beverage pref #2 (americano) — same topic as #1    |
| `ambient/mara.md`                     | ambient    | team note #1                                       |
| `ambient/jin.md`                      | ambient    | team note #2 — same topic as #1                    |
| `style/brevity.md` / `style/short.md` | style      | identical bodies — exact duplicate                 |
| `identity/editor.md`                  | preference | misfiled: in `identity/` but declares `preference` |
| `workflow/debugging.md`               | workflow   | a full 9-step SOP — over-long, should compress     |

## What the model actually did

**Phase 1 — deterministic pre-pass (no LLM).** Deleted the exact-duplicate style
file (`style/short.md`), and relocated the misfiled `identity/editor.md` →
`preference/editor.md`. Guaranteed, model-independent.

**Phase 2 — consolidation subagent (real model, 12 tool calls).** Tool usage:
`read ×5, write ×2, bash ×4, edit ×1`.

1. **Beverage merge — read-before-merge, no data loss.** The subagent called
   `read` on **both** `coffee.md` and `tea.md` (full bodies) _before_
   writing, then `write` one `preference/Drinks` keeping **both** items
   ("prefers green tea as their daily drink, and also enjoys an americano coffee
   in the afternoon"), then `bash` on each source. This is the core
   invariant: it never authored the merged body from a truncated excerpt — it read
   first. **Green tea + coffee both survive. ✅**
2. **Team merge.** Same shape: read `jin.md` + `mara.md` in full → `write`
   one `ambient/Team members` keeping both people → archive both sources. **Mara +
   Jin both survive. ✅**
3. **Compression to a trigger.** Read the 9-step debugging SOP, then
   `edit` to a 164-char summary with no numbered steps — keeping the
   durable signal, dropping the step-by-step (complete methods belong in a skill).
4. **Left identity alone.** `identity/role.md` was untouched — not folded into
   anything.

## Final store

```
identity/role.md         A backend engineer who mainly writes Go.
preference/drinks.md     The user prefers green tea as their daily drink, and also enjoys an americano coffee in the afternoon.
preference/editor.md     Uses Neovim as the main editor.
style/brevity.md         Keep replies short and to the point.
workflow/debugging.md    The user follows a structured routine for debugging production bugs, prioritizing reproduction, identifying the root cause, and verifying the fix.
ambient/team-members.md  Jin runs the infrastructure and on-call rotation, and Mara is the backend team lead.
```

## Verified invariants

- **Deterministic dedup** — exact-duplicate style note removed (2 → 1). ✅
- **Deterministic relocate** — misfiled memory moved to its declared type dir. ✅
- **Semantic merge, no data loss** — every distinct item from each source survives
  the merge, because the subagent read full bodies before writing. ✅
- **Compression** — the over-long workflow SOP became a short trigger signal. ✅
- **Identity preserved** — stable identity left untouched. ✅
- **Bounded** — the run finished well within the hard step cap (≤20).

This is the same read-before-write discipline that protects list-type appends in
extraction, now proven for consolidation against a real model.
