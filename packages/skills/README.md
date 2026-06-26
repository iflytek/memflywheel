# @memflywheel/skills

File-native learned skill layer for MemFlywheel agent runtimes.

This package stores, validates, stages, finalizes, rolls back, and renders
prompt-routing metadata for learned skills. It does not execute skills. Host
runtimes own skill loading, execution policy, permissions, and tool calls.

## Definition

A learned skill is a directory named `memflywheel-learned-<slug>` that contains:

- `SKILL.md`
- optional supporting files under `references/`, `templates/`, `scripts/`, or `assets/`

`SKILL.md` uses strict frontmatter with exactly:

```yaml
---
name: memflywheel-learned-example
display_name: Example
description: Captures a durable workflow.
---
```

The body must include `## Use Cases`, `## Procedure`, and `## Guardrails`.
`## Procedure` must contain contiguous numbered steps starting at `1.`.

## API

```ts
import {
  createLearnedSkillStore,
  createLearnedSkillRecallProvider,
  buildLearnedSkillPrelude,
  checkpointLearnedSkill,
  finalizeLearnedSkillCheckpoint,
  rollbackLearnedSkillCheckpoint,
  validateLearnedSkillPackage,
} from "@memflywheel/skills";
```

| Function | Purpose |
| --- | --- |
| `createLearnedSkillStore(input)` | Builds the high-level staged learned-skill store used by SDK skill learning. |
| `createLearnedSkillRecallProvider(input)` | Reads learned skills and returns prompt-routing entries. |
| `buildLearnedSkillPrelude(packet)` | Renders learned-skill routes as a compact prompt prelude. |
| `getLearnedSkillsCatalog(input)` | Reads and validates `memflywheel-learned-*` directories and returns a derived catalog. |
| `validateLearnedSkillPackage(input)` | Validates naming, frontmatter, sections, supporting file placement, file size, sensitive names, and configured forbidden public names. |
| `checkpointLearnedSkill(input)` | Writes staged skill files to an external checkpoint root and snapshots the existing target skill directory. |
| `finalizeLearnedSkillCheckpoint(checkpoint)` | Copies staged files into `skillsRoot/memflywheel-learned-<slug>` only after checking that no paths were deleted and no external paths changed. |
| `rollbackLearnedSkillCheckpoint(checkpoint)` | Restores the complete target directory snapshot captured at checkpoint time. |

The high-level store uses a stronger finalized-skill flow:

```text
createSkillCheckpoint()
  -> stage-bound ordinary file tools: read/write/edit/bash/glob/grep
  -> finalizeLearnedSkillChanges()
       checks finalized skill tree did not change
       validates changed staged learned skills
       publishes changed skill directories
  -> rollbackSkillCheckpoint() restores the snapshot on failure
```

Prompt recall is routing-only:

```text
createLearnedSkillRecallProvider()
  -> validates learned skill directories
  -> returns name / display name / description / path / trigger hints
  -> does not execute skills or copy procedure steps into memory
```

## Safety Rules

| Rule | Enforcement |
| --- | --- |
| Learned skill directory | `memflywheel-learned-<slug>`, lowercase kebab-case. |
| Supporting files | Only under `references/`, `templates/`, `scripts/`, or `assets/`. |
| Supporting file size | Non-empty and at most 1 MiB. |
| Sensitive file names | Refuses common secret, token, password, credential, private key, `.env`, and key-file names. |
| Finalize scope | Changed paths must be inside the learned skill directory. |
| Finalize deletion | Unapproved or partial deletion aborts finalize; a merge may delete whole redundant skill directories declared in `mergedSkills`. |
| Rollback | Restores the full target snapshot, not a hash-only marker. |
