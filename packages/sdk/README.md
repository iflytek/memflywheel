# @memflywheel/sdk

The SDK owns MemFlywheel's lifecycle and one write-side agent implementation:

```text
Extraction ─┐
Dream ──────┼─> runMemoryAgent() ─> @earendil-works/pi-agent-core Agent
Skill ──────┘                           |
                                         └─ host-resolved pi-ai Model + StreamFn
```

Hosts provide a `ResolvePiAgentModel` that returns the active `Model`, `streamFn`, auth resolver, session id, and thinking level. The SDK does not parse provider wire formats, replay reduced assistant messages, read write-side LLM environment variables, or implement its own retry loop.

```ts
import { createExtractionAgentRunner } from "@memflywheel/sdk";

const agent = createExtractionAgentRunner({ resolveModel });
```

Tool execution is sequential because memory and skill tools mutate files. A provider error, abort, or `maxSteps` breach fails the pass; callers must not advance cursors or finalize staged skills after a partial run.
