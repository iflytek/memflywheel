/**
 * MemFlywheel × Pi — comprehensive, boundary-focused end-to-end test (real model: DeepSeek).
 *
 * Written to be run, read, and iterated on. Scenarios are grouped:
 *   A · 记忆闭环 (memory loop)      — needs a real model
 *   B · 技能闭环 (skill loop)       — needs a real model; signals are TRAJECTORY-DERIVED
 *                                     from captured tool calls
 *   C · 边界 (boundaries)           — DETERMINISTIC, no model/key required
 *   D · 真实 Pi 接入 (PI_REAL=1)    — boots a real Pi AgentSession
 *
 * The C (boundary) group runs WITHOUT a key, so this file is useful immediately.
 * A/B run only when a key is present; D runs only with PI_REAL=1 and a key.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY: never hardcode a key. Read it from the env.
 *
 *   export MEMFLYWHEEL_LLM_API_KEY=sk-...                 # your DeepSeek key
 *   export MEMFLYWHEEL_LLM_ENDPOINT=https://api.deepseek.com/v1
 *   export MEMFLYWHEEL_LLM_MODEL=deepseek-v4-flash
 *
 *   node examples/pi/e2e-deepseek.mjs                   # A+B (if key) + C (always)
 *   PI_REAL=1 node examples/pi/e2e-deepseek.mjs         # also boot real Pi (D)
 *   node examples/pi/e2e-deepseek.mjs                   # no key → runs only C
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMemFlywheelHarnessRuntime,
  createPiHarnessPort,
  classifyHostCapabilities,
  requireHostCapabilities,
  createCapabilitySet,
} from "@iflytekopensource/adapters";
import { createOpenAIChatCompletionsModel } from "@memflywheel/model";
import {
  validateLearnedSkillPackage,
  LearnedSkillValidationError,
  createLearnedSkillStore,
  createLearnedSkillRecallProvider,
  buildLearnedSkillPrelude,
} from "@memflywheel/skills";

// ───────────────────────────── config ──────────────────────────────────────

const ENDPOINT =
  process.env.MEMFLYWHEEL_LLM_ENDPOINT ??
  process.env.DEEPSEEK_BASE_URL ??
  "https://api.deepseek.com/v1";
const MODEL =
  process.env.MEMFLYWHEEL_LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const API_KEY =
  process.env.MEMFLYWHEEL_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
const HAVE_KEY = Boolean(API_KEY);
const CAPTURE_PROXY = HAVE_KEY && process.env.MEMFLYWHEEL_CAPTURE_PROXY !== "0";
let ACTIVE_ENDPOINT = ENDPOINT;
let ACTIVE_API_KEY = API_KEY;
const proxyLog = [];

function buildModel() {
  return createOpenAIChatCompletionsModel({
    endpoint: ACTIVE_ENDPOINT,
    apiKey: ACTIVE_API_KEY,
    model: MODEL,
  });
}

function redactString(value) {
  let out = value;
  if (API_KEY) out = out.split(API_KEY).join("[REDACTED_API_KEY]");
  return out
    .replace(/Bearer\s+sk-[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "[REDACTED_SECRET]");
}

function redactJson(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = /authorization|api[_-]?key|token|secret/i.test(key)
        ? "[REDACTED]"
        : redactJson(child);
    }
    return out;
  }
  return value;
}

function requestBodySummary(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    model: body?.model,
    tool_choice: body?.tool_choice,
    max_tokens: body?.max_tokens,
    temperature: body?.temperature,
    messageRoles: messages.map((m) => m?.role),
    promptHead: messages
      .map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")))
      .join("\n")
      .slice(0, 1200),
    toolNames: tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean),
  };
}

async function startCaptureProxy() {
  const upstream = ENDPOINT.replace(/\/+$/, "");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const entry = {
      method: req.method,
      url: req.url,
      request: redactJson(body),
      summary: requestBodySummary(body),
    };
    proxyLog.push(entry);

    const suffix = (req.url ?? "").replace(/^\/v1(?=\/|$)/, "");
    const target = `${upstream}${suffix}`;
    const headers = { ...req.headers, authorization: `Bearer ${API_KEY}` };
    delete headers.host;
    delete headers["content-length"];

    try {
      const upstreamResponse = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
      });
      entry.status = upstreamResponse.status;
      res.writeHead(
        upstreamResponse.status,
        Object.fromEntries(upstreamResponse.headers.entries()),
      );
      res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
    } catch (error) {
      entry.error = redactString(error?.message ?? String(error));
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: entry.error }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  ACTIVE_ENDPOINT = `http://127.0.0.1:${address.port}/v1`;
  ACTIVE_API_KEY = "memflywheel-local-proxy-token";
  return {
    url: ACTIVE_ENDPOINT,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ──────────────────────────── tiny harness ─────────────────────────────────

const results = [];
function banner(t) {
  console.log("\n" + "═".repeat(74) + "\n  " + t + "\n" + "═".repeat(74));
}
function record(name, status, detail = "") {
  results.push({ name, status });
  const icon =
    status === "pass" ? "✅" : status === "warn" ? "⚠️ " : status === "skip" ? "⏭️ " : "❌";
  console.log(`  ${icon} ${name}${detail ? " — " + detail : ""}`);
}
function check(name, cond, detail = "") {
  record(name, cond ? "pass" : "fail", detail);
  return cond;
}
/** Assert a synchronous call throws (optionally matching a message). */
function expectThrows(name, fn, re) {
  try {
    fn();
    record(name, "fail", "did NOT throw");
    return false;
  } catch (err) {
    const msg = err?.message ?? String(err);
    const ok = !re || re.test(msg);
    record(name, ok ? "pass" : "fail", ok ? "" : `threw but message mismatch: ${msg}`);
    return ok;
  }
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}
const readSafe = (p) => readFile(p, "utf8").catch(() => "");

async function dumpRoot(label, root) {
  const index = await readSafe(path.join(root, "MEMORY.md"));
  const files = await listFiles(root);
  console.log(`\n  ── ${label}: ${root}`);
  console.log("  MEMORY.md:\n" + (index ? index.replace(/^/gm, "    ") : "    (empty)"));
  console.log(
    `  files (${files.length}): ${files.map((f) => path.relative(root, f)).join(", ") || "(none)"}`,
  );
  return { index, files };
}

/** A SKILL.md that passes validateLearnedSkillPackage (strict frontmatter + 3 sections). */
function validSkillMd(slug, displayName, description) {
  return [
    "---",
    `name: memflywheel-learned-${slug}`,
    `display_name: ${displayName}`,
    `description: ${description}`,
    "---",
    "",
    "## Use Cases",
    "- 当用户要执行该流程时。",
    "",
    "## Procedure",
    "1. 第一步。",
    "2. 第二步。",
    "3. 第三步。",
    "",
    "## Guardrails",
    "- 前置条件不满足时不要继续。",
    "",
  ].join("\n");
}

// ──────────────────── scenario transcripts (adapter messages) ───────────────
// onTurnEnd accepts: { role, text, toolCalls?: [{ name, input, output }] }

const factsTranscript = [
  {
    role: "user",
    text:
      "记一下我的偏好：我叫 Kai，主力项目是 MemFlywheel。我喝咖啡只喝美式不加糖。" +
      "回复我语气要简洁直接、不要寒暄。常用部署区域是 ap-singapore。",
  },
  { role: "assistant", text: "明白，已记住。" },
];

const procedureTranscript = [
  {
    role: "user",
    text: "把 MemFlywheel 的发布流程完整跑一遍。这是我的长期发布约定，必须沉淀成以后可复用的发布 skill。",
  },
  {
    role: "assistant",
    text: "执行发布流程。",
    toolCalls: [
      { name: "bash", input: { command: "pnpm -r build" }, output: "build ok" },
      { name: "bash", input: { command: "pnpm -r test" }, output: "242 passed" },
      {
        name: "bash",
        input: { command: "npm publish --access public" },
        output: "+ memflywheel@0.1.0",
      },
    ],
  },
  {
    role: "assistant",
    text:
      "发布完成。标准流程：1) pnpm -r build；2) pnpm -r test 全绿；3) 更新 CHANGELOG.md；" +
      "4) npm publish --access public；5) git tag v<version> 并 push。",
  },
];

// Same skill, but this turn the publish step FAILS — the failure lives in the
// tool trajectory (no manual usage channel). Evolution should learn from it.
const failureTranscript = [
  {
    role: "user",
    text:
      "再按发布流程发一版。记住这个长期发布经验：如果 npm publish 返回 401，" +
      "以后发布 skill 必须先做 npm auth token / NPM_TOKEN preflight。",
  },
  {
    role: "assistant",
    text: "按既有发布流程执行。",
    toolCalls: [
      { name: "bash", input: { command: "pnpm -r build" }, output: "build ok" },
      { name: "bash", input: { command: "pnpm -r test" }, output: "242 passed" },
      {
        name: "bash",
        input: { command: "npm publish --access public" },
        output: "npm ERR! code E401\nnpm ERR! 401 Unauthorized - no auth token",
      },
    ],
  },
  { role: "assistant", text: "发布失败：npm 返回 401 未授权（没有 auth token）。" },
];

const secretTranscript = [
  {
    role: "user",
    text:
      "存一下我的发布习惯：用 GitHub Actions 发布。我的临时 token 是 " +
      "sk-" +
      "ABCDEF0123456789ABCDEF（别存这个）。",
  },
  { role: "assistant", text: "好的，发布习惯已记，敏感凭据不会保存。" },
];

// ═══════════════════════ GROUP A · 记忆闭环 (real model) ═══════════════════════

async function groupA() {
  const root = await mkdtemp(path.join(tmpdir(), "ms-A-"));
  const sessionId = "A";

  banner("A1 · recall-only 模式：能召回、不抽取（无需模型）");
  {
    const { scribe, mode } = createMemFlywheelHarnessRuntime({ root, mode: "recall-only" });
    check("A1 mode is recall-only", mode === "recall-only", `mode=${mode}`);
    await scribe.onSessionStart({ sessionId });
    const ctx = await scribe.onPromptBuild({ sessionId });
    check("A1 prompt-build returns a context", typeof ctx?.enabled === "boolean");
  }

  if (!HAVE_KEY) {
    record("A2 extraction", "skip", "no key");
    record("A3 cross-turn recall", "skip", "no key");
    record("A4 dream", "skip", "no key");
    record("A5 privacy (memory)", "skip", "no key");
    return root;
  }

  const { scribe } = createMemFlywheelHarnessRuntime({ model: buildModel(), root });
  await scribe.onSessionStart({ sessionId });

  banner("A2 · turn-end 抽取写出真实 memory 文件");
  const turn = await scribe.onTurnEnd({ sessionId, messages: factsTranscript });
  console.log("  onTurnEnd:", JSON.stringify(turn).slice(0, 200));
  const after = await dumpRoot("after extraction", root);
  check("A2 MEMORY.md non-empty", after.index.trim().length > 0);
  check(
    "A2 a memory file written",
    after.files.some((f) => !f.endsWith("MEMORY.md")),
  );

  banner("A3 · 跨轮召回：上轮记忆注入下轮 prompt");
  const ctx = await scribe.onPromptBuild({ sessionId });
  const recall = `${ctx.systemPrompt ?? ""}\n${ctx.preludePrompt ?? ""}\n${ctx.skillPreludePrompt ?? ""}`;
  console.log("  prelude (head):", (ctx.preludePrompt ?? "").slice(0, 200).replace(/\n/g, " "));
  const recalledSignals = [
    /preference|偏好|coffee|咖啡|美式/i,
    /style|风格|tone|语气|简洁/i,
    /identity|身份|name|Kai/i,
    /context|项目|MemFlywheel|deployment|ap-singapore|singapore/i,
  ].filter((re) => re.test(recall)).length;
  check(
    "A3 prior memory recalled",
    /可用记忆条目|Available memories/i.test(recall) && recalledSignals >= 2,
  );

  banner("A4 · idle → dream 整理，索引仍一致");
  let dream;
  try {
    dream = await scribe.onIdle({ force: true });
  } catch (e) {
    dream = `threw: ${e?.message}`;
  }
  console.log("  onIdle(force):", JSON.stringify(dream ?? null).slice(0, 160));
  const d = await dumpRoot("after dream", root);
  check("A4 dream ran, index still readable", typeof d.index === "string");

  banner("A5 · 隐私边界：transcript 里的 secret 永不落盘");
  await scribe.onTurnEnd({ sessionId, messages: secretTranscript });
  const dump = await dumpRoot("after secret turn", root);
  const allText = (await Promise.all(dump.files.map(readSafe))).join("\n") + dump.index;
  check("A5 secret NOT persisted", !new RegExp("sk-" + "ABCDEF0123456789").test(allText));

  await scribe.onSessionEnd({ sessionId });
  return root;
}

// ════════════════ GROUP B · 技能闭环（轨迹驱动, real model）════════════════════

async function groupB() {
  if (!HAVE_KEY) {
    for (const n of [
      "B1 skill evolution",
      "B2 skill route recall",
      "B3 trajectory-derived update",
      "B4 memory→cue",
    ])
      record(n, "skip", "no key");
    return null;
  }
  const root = await mkdtemp(path.join(tmpdir(), "ms-B-"));
  const skillsRoot = await mkdtemp(path.join(tmpdir(), "ms-B-skills-"));
  const checkpointRoot = await mkdtemp(path.join(tmpdir(), "ms-B-checkpoints-"));
  await mkdir(skillsRoot, { recursive: true });

  const { scribe } = createMemFlywheelHarnessRuntime({
    model: buildModel(),
    root,
    learnedSkills: {
      skillsRoot,
      checkpointRoot,
      reviewPacket: (input) => {
        const recent = JSON.stringify(input.session.messages);
        const failure = /401|Unauthorized|auth token/i.test(recent);
        return {
          goal: failure
            ? "Update the existing release skill with an auth-token preflight learned from the failing trajectory."
            : "Create a reusable release runbook learned skill from this successful release trajectory.",
          requiredDecision: failure ? "update" : "create",
          targetSkill: "memflywheel-learned-release-runbook",
          requiredFiles: ["memflywheel-learned-release-runbook/SKILL.md"],
          lastExtraction: {
            result: input.lastExtraction.result,
            skipped: input.lastExtraction.skipped,
          },
          recentMessages: input.session.messages.slice(-8),
        };
      },
    },
    // Force the gate so a single rich turn triggers evolution in this demo.
    learningLoop: {
      gate: { minDoneTurns: 0, cooldownTurns: 0, minToolCalls: 0 },
      toolCalls: 99,
      turnsSinceLastSkillEvolution: 99,
    },
  });
  const sessionId = "B";
  await scribe.onSessionStart({ sessionId });

  banner("B1 · 技能演化：可复用流程 + 工具轨迹 → 生成合法 learned skill 包");
  let t1;
  try {
    t1 = await scribe.onTurnEnd({ sessionId, messages: procedureTranscript });
  } catch (error) {
    record("B1 skill evolution", "fail", error?.message ?? String(error));
    return { root, skillsRoot };
  }
  console.log("  onTurnEnd:", JSON.stringify(t1).slice(0, 400));
  let skillFiles = (await listFiles(skillsRoot)).filter((f) => /SKILL\.md$/i.test(f));
  for (const f of skillFiles)
    console.log(
      `\n  ── ${path.relative(skillsRoot, f)}\n` + (await readSafe(f)).replace(/^/gm, "    "),
    );
  record(
    "B1 a learned skill package was created",
    skillFiles.length > 0 ? "pass" : "warn",
    skillFiles.length ? "" : "model declined — inspect onTurnEnd",
  );

  banner("B2 · 技能路由召回：新技能以 name+path 出现在 skillPrelude");
  const ctx = await scribe.onPromptBuild({ sessionId });
  const sp = ctx.skillPreludePrompt ?? "";
  console.log("  skillPrelude:\n" + (sp ? sp.replace(/^/gm, "    ") : "    (empty)"));
  record(
    "B2 skill route present (name + path)",
    /## 可用技能/.test(sp) && /path:/.test(sp) ? "pass" : "warn",
    sp ? "" : "depends on B1",
  );

  banner("B3 · 轨迹派生失败 → 技能更新（纯看工具轨迹）");
  const before = skillFiles.length ? await readSafe(skillFiles[0]) : "";
  let t2;
  try {
    t2 = await scribe.onTurnEnd({ sessionId, messages: failureTranscript });
  } catch (error) {
    record("B3 trajectory-derived update", "fail", error?.message ?? String(error));
    return { root, skillsRoot };
  }
  console.log("  onTurnEnd:", JSON.stringify(t2).slice(0, 400));
  const after = skillFiles.length ? await readSafe(skillFiles[0]) : "";
  record(
    "B3 evolution reacted to the failing trajectory",
    before && after && before !== after ? "pass" : "warn",
    before === after
      ? "skill unchanged — model may have declined; inspect output"
      : "skill updated",
  );

  banner("B4 · memory → routing cue：流程型记忆压成指向技能的 cue（人工核查）");
  const mem = await readSafe(path.join(root, "MEMORY.md"));
  console.log("  MEMORY.md:\n" + (mem ? mem.replace(/^/gm, "    ") : "    (empty)"));
  // Tolerant: assert memory does NOT duplicate the full numbered procedure verbatim.
  const dupSteps = /1\)\s*pnpm -r build[\s\S]*2\)\s*pnpm -r test[\s\S]*3\)/.test(mem);
  record(
    "B4 memory keeps a cue, not the full procedure",
    dupSteps ? "warn" : "pass",
    dupSteps ? "full steps still in memory — inspect" : "",
  );

  await scribe.onSessionEnd({ sessionId });
  return { root, skillsRoot };
}

// ══════════════════ GROUP C · 边界 (deterministic, no key) ═════════════════════

async function groupC() {
  banner("C1 · 技能不执行：MemFlywheel 只 store/validate/evolve，无 execute/run/spawn");
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-C1-"));
    const store = createLearnedSkillStore({
      skillsRoot: path.join(root, "skills"),
      checkpointRoot: path.join(root, "checkpoints"),
    });
    const forbidden = ["execute", "run", "spawn", "load", "invoke", "exec"];
    const storeClean = forbidden.every((m) => typeof store[m] !== "function");
    check(
      "C1 store exposes no execution method",
      storeClean,
      `store keys: ${Object.keys(store).join(",")}`,
    );
    const { scribe } = createMemFlywheelHarnessRuntime({ root, mode: "recall-only" });
    const scribeClean = forbidden.every((m) => typeof scribe[m] !== "function");
    check("C1 scribe exposes no execution method", scribeClean);
  }

  banner("C2 · 能力分级：classifyHostCapabilities");
  {
    const all = createCapabilitySet([
      "prompt-build",
      "turn-end",
      "session-end",
      "idle",
      "single-tool-completion",
      "agentic-tool-loop",
      "tool-trajectory",
    ]);
    check("C2 full caps → skill-loop", classifyHostCapabilities(all) === "skill-loop");
    check(
      "C2 drop tool-trajectory → memory-loop",
      classifyHostCapabilities(
        createCapabilitySet(["prompt-build", "turn-end", "agentic-tool-loop"]),
      ) === "memory-loop",
    );
    check(
      "C2 only prompt-build → recall-only",
      classifyHostCapabilities(createCapabilitySet(["prompt-build"])) === "recall-only",
    );
    check("C2 empty → none", classifyHostCapabilities(createCapabilitySet([])) === "none");
    const stubPi = { on: () => () => {} };
    const stubModel = { complete: async () => ({ message: { role: "assistant", content: null } }) };
    const port = createPiHarnessPort(stubPi, { model: stubModel });
    check(
      "C2 Pi port classifies as skill-loop",
      classifyHostCapabilities(port.capabilities) === "skill-loop",
    );
  }

  banner("C3 · fail-fast：缺 model / 缺能力 → 显式抛错（无静默降级）");
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-C3-"));
    expectThrows(
      "C3 no model & not recall-only → throws",
      () => createMemFlywheelHarnessRuntime({ root }),
      /canonical model/i,
    );
    let ok = true;
    try {
      createMemFlywheelHarnessRuntime({ root, mode: "recall-only" });
    } catch {
      ok = false;
    }
    check("C3 recall-only constructs without a model", ok);
    expectThrows(
      "C3 requireHostCapabilities throws on missing cap",
      () =>
        requireHostCapabilities("test", createCapabilitySet(["prompt-build"]), [
          "prompt-build",
          "turn-end",
        ]),
      /missing host capabilities/i,
    );
  }

  banner("C4 · 校验边界：validateLearnedSkillPackage 接受合法、拒绝非法");
  {
    const valid = {
      slug: "release-runbook",
      files: {
        "SKILL.md": validSkillMd(
          "release-runbook",
          "Release Runbook",
          "Use when publishing MemFlywheel to npm.",
        ),
      },
    };
    let okValid = true;
    try {
      const v = validateLearnedSkillPackage(valid);
      okValid = v.skillName === "memflywheel-learned-release-runbook";
    } catch (e) {
      okValid = false;
      console.log("  unexpected:", e?.message);
    }
    check("C4 valid package passes", okValid);

    expectThrows(
      "C4 missing SKILL.md → rejected",
      () => validateLearnedSkillPackage({ slug: "x", files: { "references/a.md": "hi" } }),
      /SKILL\.md/,
    );
    expectThrows("C4 missing required section → rejected", () =>
      validateLearnedSkillPackage({
        slug: "x",
        files: {
          "SKILL.md":
            "---\nname: memflywheel-learned-x\ndisplay_name: X\ndescription: d\n---\n\n## Use Cases\n- a\n",
        },
      }),
    );
    expectThrows("C4 forbidden public name → rejected", () =>
      validateLearnedSkillPackage({
        slug: "y",
        forbiddenPublicNames: ["AcmeInternal"],
        files: {
          "SKILL.md": validSkillMd("y", "Y", "desc").replace(
            "第一步。",
            "参考 AcmeInternal 内部实现。",
          ),
        },
      }),
    );
    check(
      "C4 LearnedSkillValidationError is exported",
      typeof LearnedSkillValidationError === "function",
    );
  }

  banner("C6 · skillsRoot 可达性：路由 path 相对 skillsRoot 且可解析到真实文件");
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-C6-"));
    const skillsRoot = path.join(root, "skills");
    const dir = path.join(skillsRoot, "memflywheel-learned-demo-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      validSkillMd("demo-skill", "Demo Skill", "Use when running the demo."),
    );
    const recall = createLearnedSkillRecallProvider({ skillsRoot });
    const packet = await recall({ sessionId: "x" });
    const prelude = buildLearnedSkillPrelude(packet);
    console.log("  prelude:\n" + prelude.replace(/^/gm, "    "));
    const m = prelude.match(/path:\s*(\S+)/);
    check("C6 route includes a path", Boolean(m));
    if (m) {
      const abs = path.resolve(skillsRoot, m[1]);
      const exists = await readFile(abs, "utf8")
        .then(() => true)
        .catch(() => false);
      check(
        "C6 path is relative + resolves under skillsRoot to a real file",
        !path.isAbsolute(m[1]) && exists,
        abs,
      );
    }
  }
}

// ═══════════════════ GROUP D · 真实 Pi 接入 (PI_REAL=1) ════════════════════════

async function groupD() {
  banner("D · 真实 Pi AgentSession（DeepSeek 当 Pi 主模型）+ MemFlywheel 扩展");
  if (!HAVE_KEY) {
    record("D real Pi", "skip", "no key");
    return;
  }
  let pic, pai;
  try {
    pic = await import("@earendil-works/pi-coding-agent");
    pai = await import("@earendil-works/pi-ai");
  } catch (err) {
    record("D pi packages resolvable", "fail", `import failed: ${err?.message ?? err}`);
    console.log("  Install/link Pi packages before running PI_REAL=1.");
    return;
  }
  record("D pi packages resolvable", "pass");

  const {
    createAgentSession,
    DefaultResourceLoader,
    AuthStorage,
    ModelRegistry,
    SessionManager,
    SettingsManager,
  } = pic;
  const { completeSimple } = pai;
  const root = await mkdtemp(path.join(tmpdir(), "ms-D-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("deepseek", ACTIVE_API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  const model = {
    id: MODEL,
    name: "DeepSeek",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: ACTIVE_ENDPOINT,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
  };
  check(
    "D DeepSeek model constructed for Pi",
    model.api === "openai-completions" && model.baseUrl === ACTIVE_ENDPOINT,
  );

  let injections = 0,
    turnEnds = 0,
    toolEvents = 0;

  const extension = (pi) => {
    const originalOn = pi.on.bind(pi);
    pi.on = (event, handler) => {
      const wrapped = async (...args) => {
        if (event === "context") injections += 1;
        if (event === "agent_end") turnEnds += 1;
        return handler(...args);
      };
      return originalOn(event, wrapped);
    };
    const port = createPiHarnessPort(pi, { completeSimple });
    const runtime = createMemFlywheelHarnessRuntime({ port, root });
    pi.on("tool_call", async () => {
      toolEvents += 1;
    });
    pi.on("tool_result", async () => {
      toolEvents += 1;
    });
    return runtime.dispose;
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.create(root, agentDir),
    extensionFactories: [extension],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
  });
  try {
    await session.prompt(
      "先使用 Pi 原生 bash 工具执行 `pwd`；" +
        "然后记住：我叫 Kai，做 MemFlywheel，喝美式不加糖。最后用一句话给我今天的建议。",
    );
  } catch (err) {
    record("D real turn completed", "fail", `session.prompt threw: ${err?.message ?? err}`);
  } finally {
    session.dispose?.();
  }
  await new Promise((r) => setTimeout(r, 300));

  check("D context → recall injected", injections > 0, `injections=${injections}`);
  check("D agent_end → onTurnEnd fired", turnEnds > 0, `turnEnds=${turnEnds}`);
  check("D tool telemetry observed", toolEvents >= 2, `toolEvents=${toolEvents}`);
  const dump = await dumpRoot("after real Pi turn", root);
  check("D memory written from a real Pi turn", dump.index.trim().length > 0);
}

function verifyProxyCapture() {
  banner("P · 反向代理观测（raw request capture, redacted）");
  check("P requests captured", proxyLog.length > 0, `requests=${proxyLog.length}`);
  const allToolNames = new Set(proxyLog.flatMap((entry) => entry.summary?.toolNames ?? []));
  const promptText = proxyLog.map((entry) => entry.summary?.promptHead ?? "").join("\n");
  const serialized = JSON.stringify(proxyLog);
  check(
    "P extraction prompt observed",
    /memory extraction engine|Recent conversation|Existing memories/i.test(promptText),
  );
  check(
    "P file tools exposed",
    ["read", "write", "edit", "bash", "glob", "grep"].every((name) => allToolNames.has(name)),
    `tools=${[...allToolNames].sort().join(",")}`,
  );
  check("P no API key in captured logs", !API_KEY || !serialized.includes(API_KEY));
  check(
    "P no bearer secret in captured logs",
    !/Bearer\s+sk-|sk-[A-Za-z0-9._-]{12,}/.test(serialized),
  );
  for (const [i, entry] of proxyLog.slice(0, 8).entries()) {
    console.log(
      `  #${i + 1} ${entry.method} ${entry.url} status=${entry.status ?? "n/a"} model=${entry.summary?.model ?? "n/a"} tools=${(entry.summary?.toolNames ?? []).join(",") || "(none)"}`,
    );
    console.log(
      `     roles=${(entry.summary?.messageRoles ?? []).join(",")} prompt=${(entry.summary?.promptHead ?? "").replace(/\s+/g, " ").slice(0, 180)}`,
    );
  }
}

// ──────────────────────────────── main ─────────────────────────────────────

async function main() {
  let proxy;
  let a;
  if (CAPTURE_PROXY) {
    proxy = await startCaptureProxy();
  }
  console.log(
    `MemFlywheel × Pi E2E — model=${MODEL} endpoint=${ACTIVE_ENDPOINT} key=${HAVE_KEY ? "yes" : "NO (only group C runs)"}`,
  );
  if (proxy) console.log(`Proxy capture enabled: ${proxy.url} -> ${ENDPOINT}`);

  try {
    await groupC(); // boundaries — always (deterministic, no key)
    a = await groupA(); // memory loop — A1 always, A2+ need key
    await groupB(); // skill loop — needs key
    if (process.env.PI_REAL === "1") await groupD();
  } catch (error) {
    record("fatal", "fail", error?.message ?? String(error));
  } finally {
    if (proxy) verifyProxyCapture();
    if (proxy) await proxy.close();
  }

  banner("SUMMARY");
  const by = (s) => results.filter((r) => r.status === s).length;
  for (const r of results) {
    const icon =
      r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️ " : r.status === "skip" ? "⏭️ " : "❌";
    console.log(`  ${icon} ${r.name}`);
  }
  console.log(
    `\n  ${by("pass")} pass · ${by("warn")} warn · ${by("skip")} skip · ${by("fail")} fail`,
  );
  if (a) console.log(`  memory root: ${a}`);
  process.exit(by("fail") > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
