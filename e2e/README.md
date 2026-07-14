# E2E Test Framework

K8s end-to-end test framework that validates the memflywheel memory extraction lifecycle across different AI agents.

## Architecture

```
e2e/
├── run.mjs              # Single entry point: iterates agents x cases
├── agents.mjs           # Agent configurations (Hermes, Pi)
├── cases.mjs            # Test cases (pure data)
├── test-helpers.mjs     # Core utilities (kubectl, check, runCase, pushCaseConfig)
├── mock-llm/            # Mock OpenAI LLM service (data-driven)
├── pi/                  # Pi-specific scripts (extension, extract, models, settings)
└── kind/                # K8s manifests (Dockerfiles, sandbox YAMLs, scripts)
```

**Core flow:**

```
run.mjs
  │
  ├── for each agent in AGENTS:
  │     ├── waitForPodReady()
  │     ├── agent.waitForSetup()     ← optional (e.g. Hermes plugin install wait)
  │     ├── agent.verifySetup()      ← verify agent installation
  │     │
  │     └── for each case in CASES:
  │           ├── pushCaseConfig()   ← push case data to mock-llm
  │           ├── chatFn(prompt)     ← send conversation
  │           ├── afterTurns()       ← optional (e.g. Pi standalone extraction)
  │           └── assertMemory()     ← verify MEMORY.md content
  │
  └── printSummary()
```

## Running Tests

### Prerequisites

```bash
# 1. Create kind cluster
bash e2e/kind/setup.sh

# 2. Build and load Docker images into kind
docker build -t mock-llm:e2e -f e2e/mock-llm/Dockerfile e2e/mock-llm/
docker build -t hermes-memflywheel:e2e -f e2e/kind/Dockerfile.hermes .
docker build -t pi-memflywheel:e2e -f e2e/kind/Dockerfile.pi .

kind load docker-image mock-llm:e2e --name memflywheel-e2e
kind load docker-image hermes-memflywheel:e2e --name memflywheel-e2e
kind load docker-image pi-memflywheel:e2e --name memflywheel-e2e

# 3. Deploy services
kubectl apply -f e2e/kind/mock-llm-deployment.yaml
kubectl apply -f e2e/kind/hermes-sandbox.yaml
kubectl apply -f e2e/kind/pi-sandbox.yaml
```

### Execute

```bash
node e2e/run.mjs
```

Example output:

```
🧪 Hermes K8s E2E
  ✅ pod ready
  ✅ hermes binary available
  ...
── case: preference: tea + tone
  ✅ turn 1 completed — That sounds like a wonderful morning ritual!...
  ✅ tea preference captured
  ✅ tone preference captured

🧪 Pi K8s E2E
  ✅ pod ready
  ...

── summary
  pass: 23  fail: 0  total: 23
✅ ALL PASSED
```

---

## How to Add a New Test Case

Append an object to the `CASES` array in `cases.mjs`. Each case has three parts:

### (a) prompts — Conversation turns

```javascript
prompts: [
  {
    text: "Message sent by the user",       // prompt sent to the agent
    waitMs: 5000,                           // wait time for agent response (ms)
    chatResponse: "mock-llm reply text",    // assistant message returned by mock-llm
  },
],
```

### (b) extraction — Memory extraction rules

```javascript
extraction: [
  {
    match: "keyword|regex",               // regex to match user message (no delimiters)
    filePath: "preference/xxx.md",        // extracted file path (relative to memory root)
    frontmatter: {
      type: "preference",                 // memory type
      name: "Display Name",               // name in MEMORY.md index
      description: "Description",         // description in MEMORY.md index
      terms: ["term1", "term2"],          // retrieval keywords
    },
    body: "Extracted memory body text",   // file body content
  },
],
```

### (c) assertions — Verification checks

```javascript
assertions: [
  {
    label: "assertion description",       // name shown by check()
    regex: /match regex/i,                // regex to search in MEMORY.md content
  },
],
```

### Complete Example

```javascript
// cases.mjs
export const CASES = [
  {/* ... existing case ... */},
  {
    name: "fact: programming language",
    prompts: [
      {
        text: "I primarily use Python and Rust for my projects.",
        waitMs: 5000,
        chatResponse: "Great choices! Python and Rust are both excellent languages.",
      },
    ],
    extraction: [
      {
        match: "python|rust|programming|language",
        filePath: "fact/programming.md",
        frontmatter: {
          type: "fact",
          name: "Programming Languages",
          description: "User's preferred programming languages",
          terms: ["python", "rust", "programming"],
        },
        body: "The user primarily uses Python and Rust for projects.",
      },
    ],
    assertions: [{ label: "programming languages captured", regex: /python|rust/i }],
  },
];
```

> **Note**: `prompts` and `extraction` arrays correspond by index — the Nth prompt triggers the Nth extraction rule. The `match` regex is used to match keywords in the user's message.

---

## How to Add a New Agent

Append a config object to the `AGENTS` array in `agents.mjs`:

```javascript
{
  name: "NewAgent",                    // display name
  namespace: "newagent-test",          // K8s namespace
  sandbox: "newagent-agent",           // Sandbox CR name
  chatFn: (prompt) =>                  // function to send a prompt
    kubectlExec("newagent-test", "newagent-agent", "newagent", "chat", prompt),
  waitForSetup: null,                  // optional: async function to wait for runtime install
  verifySetup: () => {                 // installation verification with check() calls
    check("binary available", ...);
  },
  afterTurns: null,                    // optional: post-conversation hook (e.g. standalone extraction)
  memoryPaths: ["/path/to/MEMORY.md"], // candidate paths for MEMORY.md
  memoryDirs: ["/path/to/memory"],     // memory directories (debug scan)
  debugDir: "/path/to/memory",         // directory for debug file listing
}
```

Also required:

1. Create a `Dockerfile` and `sandbox.yaml` under `e2e/kind/`
2. Add namespace creation in `e2e/kind/setup.sh`
3. Build the image and load it into kind

---

## How mock-llm Works

mock-llm is a data-driven OpenAI-compatible HTTP service:

1. **Config push**: Before each case, `pushCaseConfig()` writes case data to `/tmp/case-config.json` inside the mock-llm pod
2. **Chat response**: mock-llm matches user text against configured `chat` rules and returns the corresponding `chatResponse`
3. **Memory extraction**: When a request includes `write` + `glob` tools, a 3-stage extraction flow runs:
   - Stage 0: Returns `glob("**/*.md")` to check existing files
   - Stage 1: Matches `extraction` rules, returns `write()` to create the memory file
   - Stage 2: Returns "Memory extraction complete"

---

## Cleanup

```bash
bash e2e/kind/cleanup.sh
```
