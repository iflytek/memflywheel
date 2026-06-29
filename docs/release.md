# Release and npm Publishing

This document defines the release channel, versioning rule, and npm publishing
checklist for MemFlywheel.

## Release channel

MemFlywheel publishes npm packages from GitHub Actions.

| Channel | Trigger | Workflow | Output |
|---|---|---|---|
| Stable npm release | Push a `v*` git tag | `.github/workflows/release.yml` | Public npm packages |
| Preview package | Push a `v*` git tag | `.github/workflows/preview-release.yml` | `pkg-pr-new` preview output |
| Pull request validation | Pull request to `main` | `.github/workflows/ci.yml` | Build, test, pack dry run |

The root `memflywheel` package is private and is not published. Only workspace
packages under `packages/*` are release candidates.

## Published packages

| Package | Purpose |
|---|---|
| `@memflywheel/core` | File-backed memory kernel |
| `@memflywheel/model` | Provider-neutral model protocol and OpenAI-compatible mappers |
| `@memflywheel/sdk` | Host lifecycle SDK and memory/dream/skill loops |
| `@memflywheel/skills` | Learned-skill package store, validation, finalize, rollback, and recall |
| `@memflywheel/adapters` | Host lifecycle adapters and harness runtime wiring |

## Versioning rule

Use a single repository version for the release train.

1. Update the root `package.json` version.
2. Update every `packages/*/package.json` version to the same value.
3. Keep internal workspace dependencies as `workspace:*`.
4. Create the release tag as `v<version>`, for example `v0.1.0`.

Do not publish independent per-package versions unless the repository adopts a
dedicated release manager in a later change.

## Required repository secret

The stable release workflow requires this GitHub Actions secret:

| Secret | Used by | Purpose |
|---|---|---|
| `NPM_TOKEN` | `.github/workflows/release.yml` | Authenticates `pnpm -r publish` to npm |

The npm token must have publish permission for the `@memflywheel` scope.

## Pre-release checklist

Run these checks before pushing a release tag:

```sh
pnpm install
pnpm run ci
git diff --check
```

Then inspect the dry-run package output:

```sh
pnpm run pack:dry-run
```

Before tagging, confirm:

| Check | Expected result |
|---|---|
| Package versions | Root and all `packages/*` versions match |
| Package metadata | Repository URLs point to `iflytek/memflywheel` |
| Package contents | Dry-run output contains `dist`, `README.md`, `LICENSE`, and `package.json` only |
| Secrets | No credentials, private paths, or local-only files are included |
| Notices | `NOTICE` and `THIRD_PARTY_LICENSES` are current |
| CI | GitHub PR checks pass before merge |

## Release steps

```sh
git checkout main
git pull --ff-only upstream main
pnpm install
pnpm run ci

# update versions in package.json and packages/*/package.json
git checkout -b release/v<version>
git commit -s -am "chore: release v<version>"
git push -u origin release/v<version>
gh pr create --repo iflytek/memflywheel --base main --head OLDyade:release/v<version>
```

After the release PR is reviewed, merged, and `main` is up to date:

```sh
git checkout main
git pull --ff-only upstream main
git tag v<version>
```

Then a maintainer with write access to `iflytek/memflywheel` pushes the tag to
the upstream repository:

```sh
git push git@github.com:iflytek/memflywheel.git v<version>
```

Do not push the release tag only to a fork. The tag must exist in
`iflytek/memflywheel` because the release workflow runs there. Some local
checkouts intentionally set `upstream` push to `DISABLED`, so use the explicit
repository URL when needed.

## Post-release verification

After the workflow finishes:

```sh
npm view @memflywheel/core version
npm view @memflywheel/model version
npm view @memflywheel/sdk version
npm view @memflywheel/skills version
npm view @memflywheel/adapters version
```

Confirm the npm versions match the tag and that GitHub Actions completed
successfully.

## Failure handling

| Failure | Action |
|---|---|
| CI fails before tagging | Fix in a normal PR; do not tag |
| Release workflow fails before any package publishes | Fix the workflow or token, then rerun the failed workflow |
| Some packages publish and others fail | Do not delete published versions; fix the cause and publish the missing packages with the same version if npm allows it |
| Wrong package content is published | Deprecate the bad npm version and publish a corrected patch version |

Never rewrite public release tags after a tag has triggered a publish workflow.
