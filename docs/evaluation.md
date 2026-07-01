# Evaluation

MemFlywheel keeps evaluation lightweight in the public docs. The goal is to make
long-term-memory behavior measurable without turning the repository docs into an
experiment log.

## Current Signal

The main benchmark signal is LoCoMo-style long-memory QA. It checks whether the
Agent can use the file-native memory loop to answer questions through:

| Layer      | What is measured                                                    |
| ---------- | ------------------------------------------------------------------- |
| Recall     | Whether relevant `MEMORY.md` cues are surfaced before the run       |
| Reading    | Whether the Agent follows cues into memory bodies and source traces |
| Extraction | Whether durable facts are written after a turn                      |
| Learning   | Whether repeated workflows can become learned skills                |

## Local Regression

For repository-level validation, use the normal CI command:

```sh
pnpm run ci
```

That covers lint, format, TypeScript build, unit tests, example smoke tests in
GitHub Actions, and npm package dry-runs.

## Benchmark Records

Detailed experiment records, raw outputs, and local model artifacts are kept out
of `docs/`. They belong under `bench/` or external experiment tracking, not in
the public documentation surface.
