# Learning Loop Example

This example exercises the opt-in learned-skill assembly exposed by
`createMemScribeHarnessRuntime({ model, learnedSkills })`.

`USE_FAKE=1` is deterministic and runs in the default smoke suite. Without
`USE_FAKE`, the same code path calls a real OpenAI-compatible tool-calling model
through `MEMSCRIBE_LLM_*`.

```text
turn-end
  -> extraction agent writes a workflow memory through ordinary file tools
  -> skill evolution agent writes a learned skill through stage-bound ordinary file tools
  -> dream agent compresses the workflow memory into a skill cue
  -> next prompt build contains the learned skill route
```

Required environment:

```sh
export MEMSCRIBE_LLM_ENDPOINT="https://example.com/api/v1"
export MEMSCRIBE_LLM_MODEL="tool-calling-model"
export MEMSCRIBE_LLM_API_KEY="..."
export MEMSCRIBE_LLM_MAX_TOKENS=4096
node examples/learning-loop/run.mjs
```

The API key must stay in the environment. Do not write it into repository files.
