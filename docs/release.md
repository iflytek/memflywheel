# Release and npm Publishing

This document defines the release channel, versioning rule, and npm publishing
checklist for MemFlywheel.

## Release channel

MemFlywheel publishes npm packages from GitHub Actions.

| Channel                 | Trigger                | Workflow                                | Output                      |
| ----------------------- | ---------------------- | --------------------------------------- | --------------------------- |
| Stable npm release      | Push a `v*` git tag    | `.github/workflows/release.yml`         | Public npm packages         |
| Preview package         | Push a `v*` git tag    | `.github/workflows/preview-release.yml` | `pkg-pr-new` preview output |
| Pull request validation | Pull request to `main` | `.github/workflows/ci.yml`              | Build, test, pack dry run   |

The root `memflywheel` package is private and is not published. Only the two
host-facing packages are published; internal workspace packages stay private and
are bundled into the host packages when needed.

Pull requests do not publish to npmjs. A PR only proves that the packages can be
built, tested, and packed. The npmjs publish happens only after a maintainer
pushes a `v*` git tag to `iflytek/memflywheel`, which triggers the stable release
GitHub Action.

## Published packages

| Package                       | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `@iflytekopensource/adapters` | Pi, OpenCode, OpenClaw, and the shared host-adapter runtime used by Hermes |
| `@iflytekopensource/hermes`   | Hermes MemoryProvider installer and skill mirror                           |

Internal workspace packages:

| Package               | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `@memflywheel/core`   | File-backed memory kernel                                               |
| `@memflywheel/model`  | Provider-neutral model protocol and OpenAI-compatible mappers           |
| `@memflywheel/sdk`    | Host lifecycle SDK and memory/dream/skill loops                         |
| `@memflywheel/skills` | Learned-skill package store, validation, finalize, rollback, and recall |

Publish packages in dependency order:

```text
@iflytekopensource/adapters
@iflytekopensource/hermes
```

`@iflytekopensource/hermes` depends on `@iflytekopensource/adapters`, so it cannot be
published or installed first on a clean npm registry.

## Versioning rule

Use a single repository version for the release train.

1. Update the root `package.json` version.
2. Update every `packages/*/package.json` version to the same value.
3. Keep internal workspace packages private.
4. Create the release tag as `v<version>`, for example `v0.1.0`.

Do not publish independent per-package versions unless the repository adopts a
dedicated release manager in a later change.

## Required repository secret

The stable release workflow requires this GitHub Actions secret:

| Secret      | Used by                         | Purpose                                     |
| ----------- | ------------------------------- | ------------------------------------------- |
| `NPM_TOKEN` | `.github/workflows/release.yml` | Authenticates `pnpm run publish:npm` to npm |

The npm token must have publish permission for the `@iflytekopensource` scope.
The current workflow uses token-based npm publishing: `actions/setup-node`
creates the npm registry configuration, and `NODE_AUTH_TOKEN` is read from
`secrets.NPM_TOKEN`. If the project later moves to npm Trusted Publishing/OIDC,
configure the trusted publisher on npm first and change the workflow in a
separate release-infra PR.

## npm dist-tag rule

`pnpm run publish:npm` publishes both public packages with the npm `latest`
dist-tag by default. Pass a tag explicitly for prerelease channels:

```sh
pnpm run publish:npm -- --tag next --dry-run
pnpm run publish:npm -- --tag beta --dry-run
```

Do not confuse the npm dist-tag with the git release tag. Git tags still use
`v<version>`; npm dist-tags control what users install by default.

## Pre-release checklist

Run these checks before pushing a release tag:

```sh
pnpm install
pnpm run ci
pnpm run publish:npm -- --dry-run
pnpm run publish:npm -- --tag next --dry-run
git diff --check
```

Then inspect the dry-run package output:

```sh
pnpm run pack:dry-run
```

Before tagging, confirm:

| Check            | Expected result                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Package versions | Root and all `packages/*` versions match                                                   |
| Package metadata | Repository URLs point to `iflytek/memflywheel`                                             |
| Package contents | Dry-run output includes only `@iflytekopensource/adapters` and `@iflytekopensource/hermes` |
| Secrets          | No credentials, private paths, or local-only files are included                            |
| Notices          | `NOTICE` and `THIRD_PARTY_LICENSES` are current                                            |
| Publish order    | `pnpm run publish:npm -- --dry-run` publishes adapters, then Hermes                        |
| CI               | GitHub PR checks pass before merge                                                         |

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
npm view @iflytekopensource/adapters version
npm view @iflytekopensource/hermes version
```

Confirm the npm versions match the tag and that GitHub Actions completed
successfully.

## Failure handling

| Failure                                             | Action                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CI fails before tagging                             | Fix in a normal PR; do not tag                                                                                          |
| Release workflow fails before any package publishes | Fix the workflow or token, then rerun the failed workflow                                                               |
| Some packages publish and others fail               | Do not delete published versions; fix the cause and publish the missing packages with the same version if npm allows it |
| Wrong package content is published                  | Deprecate the bad npm version and publish a corrected patch version                                                     |

Never rewrite public release tags after a tag has triggered a publish workflow.
