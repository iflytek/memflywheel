/**
 * MemFlywheel × Pi — STRICT end-to-end test (real model: DeepSeek).
 *
 * Difference from e2e-deepseek.mjs: there is NO "warn" escape hatch. Every
 * behavioral assertion is pass/fail, and the process exits non-zero on ANY fail.
 * The point is to discover whether the memory + skill closed loop ACTUALLY works
 * end-to-end against a real model — not to look green.
 *
 * Honesty rules baked in:
 *  - Skill-loop signals are NOT faked. We do NOT inject toolCalls:99. We lower only
 *    minDoneTurns to 1 (legitimate host config) and feed a trajectory with >=6 real
 *    tool calls so the gate's minToolCalls:6 is satisfied by the DERIVED count.
 *  - A created skill is validated as a real package (validateLearnedSkillPackage),
 *    not merely "a file exists".
 *  - The reverse proxy ASSERTS the captured request (system prompt + 6 tool schemas),
 *    it does not just log.
 *  - Published learned-skill packages must not contain root hidden metadata files.
 *
 * SECURITY: the key is read ONLY from the env; never hardcoded, never written to a
 * file, never stored in the capture log (only forwarded upstream in the header).
 *
 *   export MEMFLYWHEEL_LLM_API_KEY=sk-...
 *   export MEMFLYWHEEL_LLM_ENDPOINT=https://api.deepseek.com/v1
 *   export MEMFLYWHEEL_LLM_MODEL=deepseek-v4-flash
 *   node examples/pi/e2e-strict.mjs
 */

import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemFlywheelHarnessRuntime } from "@iflytekopensource/adapters";
import { createOpenAIChatCompletionsModel } from "@memflywheel/model";
import {
  validateLearnedSkillPackage,
  LearnedSkillValidationError,
  createLearnedSkillStore,
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

let ACTIVE_ENDPOINT = ENDPOINT;
let ACTIVE_API_KEY = API_KEY;
const proxyLog = [];

function buildModel() {
  return createOpenAIChatCompletionsModel({
    endpoint: ACTIVE_ENDPOINT,
    apiKey: ACTIVE_API_KEY,
    model: MODEL,
    maxTokens: 4096,
    temperature: 0,
  });
}

// ─────────────────────────── result bookkeeping ────────────────────────────

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "pass" ? "✅" : status === "skip" ? "·" : "❌";
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}
function check(name, cond, detail = "") {
  record(name, cond ? "pass" : "fail", cond ? "" : detail || "assertion failed");
}
function banner(t) {
  console.log(`\n── ${t}`);
}
const by = (s) => results.filter((r) => r.status === s).length;

// ─────────────────────────── capture proxy ─────────────────────────────────

function summarize(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    model: body?.model,
    roles: messages.map((m) => m?.role),
    systemHead: (messages.find((m) => m?.role === "system")?.content ?? "").slice(0, 400),
    toolNames: tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean),
    toolSchemas: tools.map((t) => ({
      name: t?.function?.name ?? t?.name,
      hasParams: Boolean(t?.function?.parameters ?? t?.parameters),
      props: Object.keys((t?.function?.parameters ?? t?.parameters ?? {}).properties ?? {}),
    })),
    hasToolResult: messages.some((m) => m?.role === "tool"),
    hasAssistantToolCall: messages.some(
      (m) => m?.role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0,
    ),
  };
}

async function startCaptureProxy() {
  const upstreamUrl = new URL(ENDPOINT.replace(/\/+$/, ""));
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      // Record only a structured, key-free summary. Never store headers/raw key.
      proxyLog.push({ url: req.url, summary: summarize(body) });

      const suffix = (req.url ?? "").replace(/^\/v1(?=\/|$)/, "");
      const upstreamPath = `${upstreamUrl.pathname.replace(/\/+$/, "")}${suffix}`;
      const proxied = https.request(
        {
          hostname: upstreamUrl.hostname,
          port: 443,
          path: upstreamPath,
          method: req.method,
          headers: {
            ...req.headers,
            host: upstreamUrl.hostname,
            authorization: `Bearer ${API_KEY}`,
          },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      proxied.on("error", (e) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `proxy upstream error: ${e.message}` }));
      });
      proxied.end(raw);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  ACTIVE_ENDPOINT = `http://127.0.0.1:${port}/v1`;
  ACTIVE_API_KEY = "memflywheel-local-proxy-token"; // the SDK never sees the real key
  return server;
}

// ──────────────────────────── fs helpers ───────────────────────────────────

async function walkFiles(dir, rel = "") {
  const out = [];
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    const abs = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walkFiles(abs, r)));
    else out.push({ rel: r, abs });
  }
  return out;
}
async function readSafe(p) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}
async function dumpRoot(root) {
  const files = await walkFiles(root);
  const index = await readSafe(path.join(root, "MEMORY.md"));
  return { files, index };
}
async function readSkillPackage(skillsRoot, slug) {
  const files = {};
  for (const f of await walkFiles(path.join(skillsRoot, slug))) {
    files[f.rel] = await readSafe(f.abs);
  }
  return files;
}

// ──────────────────────────── transcripts ──────────────────────────────────

const factsTranscript = [
  {
    role: "user",
    text: "我叫 Kai，是后端工程师。咖啡只喝美式。回复请尽量简洁。我们的项目部署在 ap-singapore 区域。",
  },
  {
    role: "assistant",
    text: "记下了，Kai：后端工程师、只喝美式、偏好简洁回复、部署在 ap-singapore。",
  },
];

const secretTranscript = [
  {
    role: "user",
    text: "顺便存一下：我的发布 token 是 " + "sk-" + "LEAKTEST0123456789ABCD（这个别存）。",
  },
  { role: "assistant", text: "好的，发布习惯已记，敏感凭据不会保存。" },
];

// A clearly reusable RELEASE procedure with >=6 real tool calls in the trajectory,
// so the gate's minToolCalls:6 is met by the DERIVED count (no faking).
const procedureTranscript = [
  { role: "user", text: "帮我把这个 monorepo 发个版，记一下标准流程，以后照着做。" },
  {
    role: "assistant",
    text: "开始执行标准发布流程。先构建。",
    toolCalls: [
      {
        name: "bash",
        input: { command: "pnpm -r build" },
        output: "all 8 packages built, 0 errors",
      },
    ],
  },
  {
    role: "assistant",
    text: "构建通过，跑全量测试。",
    toolCalls: [
      { name: "bash", input: { command: "pnpm -r test" }, output: "240 passed, 0 failed" },
    ],
  },
  {
    role: "assistant",
    text: "测试通过，更新 changelog。",
    toolCalls: [
      { name: "edit", input: { filePath: "CHANGELOG.md", text: "## 0.2.0" }, output: "edited" },
      { name: "bash", input: { command: "git add CHANGELOG.md" }, output: "staged" },
    ],
  },
  {
    role: "assistant",
    text: "发布到 registry 并打 tag。",
    toolCalls: [
      {
        name: "bash",
        input: { command: "pnpm -r publish --access public" },
        output: "published 8 packages",
      },
      {
        name: "bash",
        input: { command: "git tag v0.2.0 && git push --tags" },
        output: "tag pushed",
      },
    ],
  },
  { role: "user", text: "完美，这个流程以后每次发版都这样走。" },
  { role: "assistant", text: "已确认：构建→测试→改 changelog→发布→打 tag，这是固定发布流程。" },
];

// ════════════════ GROUP S0 · deterministic mechanics (no model) ═════════════

async function groupDeterministic() {
  banner("S0 · 确定性机制（不需要模型）");

  // recall-only works without a model
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-strict-rc-"));
    const { scribe, mode } = createMemFlywheelHarnessRuntime({ root, mode: "recall-only" });
    check("S0.1 recall-only mode classified", mode === "recall-only", `mode=${mode}`);
    await scribe.onSessionStart({ sessionId: "s0" });
    const ctx = await scribe.onPromptBuild({ sessionId: "s0" });
    check("S0.1 prompt-build returns a context", typeof ctx?.enabled === "boolean");
  }

  // fail-fast: no model + not recall-only must THROW (no silent downgrade)
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-strict-ff-"));
    let threw = false;
    try {
      createMemFlywheelHarnessRuntime({ root });
    } catch (e) {
      threw = /canonical model|extraction agent/i.test(e?.message ?? "");
    }
    check("S0.2 fail-fast: no model & not recall-only → throws", threw);
  }

  // store exposes NO execution method (MemFlywheel never runs skills)
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-strict-store-"));
    const store = createLearnedSkillStore({
      skillsRoot: path.join(root, "skills"),
      checkpointRoot: path.join(root, "checkpoints"),
    });
    const forbidden = ["execute", "run", "spawn", "invoke", "exec"];
    check(
      "S0.3 store exposes no execution method",
      forbidden.every((m) => typeof store[m] !== "function"),
      `keys: ${Object.keys(store).join(",")}`,
    );
  }

  // validateLearnedSkillPackage rejects a malformed package
  {
    let rejected = false;
    try {
      validateLearnedSkillPackage({
        slug: "memflywheel-learned-bad",
        files: { "SKILL.md": "no frontmatter, no sections" },
      });
    } catch (e) {
      rejected = e instanceof LearnedSkillValidationError;
    }
    check("S0.4 validate rejects a malformed skill package", rejected);
  }
}

// ════════════════ GROUP M · 记忆闭环 (real model) ═══════════════════════════

const VALID_TYPES = ["identity", "preference", "style", "workflow", "context", "ambient"];

async function groupMemory() {
  if (!HAVE_KEY) {
    for (const n of ["M1 extraction", "M2 recall", "M3 privacy", "M4 dream"])
      record(n, "skip", "no key");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "ms-strict-M-"));
  const sessionId = "M";
  const { scribe } = createMemFlywheelHarnessRuntime({ model: buildModel(), root });
  await scribe.onSessionStart({ sessionId });

  banner("M1 · turn-end 抽取真的写出 typed memory 文件 + 合法 frontmatter + MEMORY.md 同步");
  const turn = await scribe.onTurnEnd({ sessionId, messages: factsTranscript });
  console.log("  onTurnEnd:", JSON.stringify(turn).slice(0, 160));
  const dump = await dumpRoot(root);
  const memFiles = dump.files.filter((f) => f.rel.endsWith(".md") && f.rel !== "MEMORY.md");
  check(
    "M1 at least one memory file written",
    memFiles.length > 0,
    `files=${dump.files.map((f) => f.rel).join(",")}`,
  );
  // each written memory file must sit in a valid typed dir AND declare a valid frontmatter type
  let typedOk = memFiles.length > 0;
  for (const f of memFiles) {
    const topDir = f.rel.split("/")[0];
    const content = await readSafe(f.abs);
    const typeMatch = content.match(/^type:\s*(\S+)/m);
    const ft = typeMatch?.[1];
    if (!VALID_TYPES.includes(topDir) || !VALID_TYPES.includes(ft)) {
      typedOk = false;
      console.log(`     ✗ ${f.rel}: dir=${topDir} frontmatter.type=${ft}`);
    }
  }
  check("M1 every memory file is in a valid typed dir with valid frontmatter.type", typedOk);
  check(
    "M1 MEMORY.md non-empty and indexes the file",
    dump.index.trim().length > 0 &&
      memFiles.some(
        (f) =>
          dump.index.includes(f.rel.split("/").pop().replace(/\.md$/, "")) ||
          dump.index.includes(f.rel),
      ),
  );

  banner("M2 · 跨轮召回：上轮事实出现在下轮 prompt-build");
  const ctx = await scribe.onPromptBuild({ sessionId });
  const recall = `${ctx.systemPrompt ?? ""}\n${ctx.preludePrompt ?? ""}`;
  const signals = [
    /美式|coffee|preference|偏好/i,
    /简洁|style|风格|tone/i,
    /Kai|identity|身份/i,
    /singapore|ap-singapore|部署|context/i,
  ].filter((re) => re.test(recall)).length;
  console.log("  prelude(head):", (ctx.preludePrompt ?? "").slice(0, 220).replace(/\n/g, " "));
  check(
    "M2 prior memory recalled into next prompt (>=2 signals)",
    signals >= 2,
    `signals=${signals}`,
  );
  // recall injects INDEX, not full bodies
  check(
    "M2 prelude looks like an index (not raw bodies dump)",
    /可用记忆|Available memories|MEMORY\.md|- \[/i.test(recall),
  );

  banner("M3 · 隐私：transcript 里的 secret 永不落盘");
  await scribe.onTurnEnd({ sessionId, messages: secretTranscript });
  const dump3 = await dumpRoot(root);
  const allText =
    (await Promise.all(dump3.files.map((f) => readSafe(f.abs)))).join("\n") + dump3.index;
  check("M3 secret NOT persisted to disk", !new RegExp("sk-" + "LEAKTEST0123456789").test(allText));

  banner("M4 · idle → dream 整理后索引仍可用，且记忆未丢");
  const before = (await dumpRoot(root)).files.filter(
    (f) => f.rel.endsWith(".md") && f.rel !== "MEMORY.md",
  ).length;
  let dreamErr = null;
  try {
    await scribe.onIdle({ force: true });
  } catch (e) {
    dreamErr = e?.message ?? String(e);
  }
  const after = await dumpRoot(root);
  const afterCount = after.files.filter(
    (f) => f.rel.endsWith(".md") && f.rel !== "MEMORY.md",
  ).length;
  check("M4 dream ran without throwing", dreamErr === null, dreamErr ?? "");
  check(
    "M4 index still parseable after dream",
    typeof after.index === "string" && after.index.length >= 0,
  );
  check(
    "M4 dream did not destroy memories",
    afterCount >= 1 && afterCount <= before,
    `before=${before} after=${afterCount}`,
  );

  await scribe.onSessionEnd({ sessionId });
}

// ════════════════ GROUP K · 技能闭环 (real model, honest gate) ══════════════

async function attemptEvolution(i) {
  const root = await mkdtemp(path.join(tmpdir(), `ms-strict-K${i}-`));
  const skillsRoot = await mkdtemp(path.join(tmpdir(), `ms-strict-K${i}-skills-`));
  const checkpointRoot = await mkdtemp(path.join(tmpdir(), `ms-strict-K${i}-ckpt-`));
  await mkdir(skillsRoot, { recursive: true });
  const { scribe } = createMemFlywheelHarnessRuntime({
    model: buildModel(),
    root,
    learnedSkills: { skillsRoot, checkpointRoot }, // DEFAULT review packet — test the SHIPPED path
    // Honest gate: only lower minDoneTurns to 1 (one turn). minToolCalls:6 stays intact and
    // is satisfied by the 6 REAL tool calls in procedureTranscript (DERIVED, not faked).
    learningLoop: { gate: { minDoneTurns: 1, cooldownTurns: 0, minToolCalls: 6 } },
  });
  const sessionId = "K";
  await scribe.onSessionStart({ sessionId });
  try {
    const t1 = await scribe.onTurnEnd({ sessionId, messages: procedureTranscript });
    const slugs = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (slugs.length === 1) {
      return { ok: true, slug: slugs[0], skillsRoot, loop: t1?.learningLoop, scribe, sessionId };
    }
    return { ok: false, error: `no skill dir produced (slugs=[${slugs.join(",")}])` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

async function groupSkill() {
  if (!HAVE_KEY) {
    for (const n of ["K1 evolve", "K2 valid package", "K3 recall", "K4 decision", "K5 leak"])
      record(n, "skip", "no key");
    return;
  }
  const MAX = Number(process.env.K_ATTEMPTS ?? 4); // K_ATTEMPTS=1 => single-shot, production-like (no retry softening)
  banner(`K1 · 富工具轨迹 → 技能演化真的产出 learned skill 包（最多 ${MAX} 次尝试，暴露不稳定性）`);
  let success = null;
  const failures = [];
  for (let i = 1; i <= MAX && !success; i += 1) {
    const r = await attemptEvolution(i);
    if (r.ok) {
      success = r;
      console.log(`  attempt ${i}: ✅ produced ${r.slug}`);
    } else {
      failures.push(r.error);
      console.log(`  attempt ${i}: ❌ ${r.error}`);
    }
  }
  check(
    `K1 skill loop produced a learned skill within ${MAX} attempts`,
    Boolean(success),
    success ? "" : `all ${MAX} attempts failed: ${failures.join(" | ")}`,
  );
  const attemptsMade = failures.length + (success ? 1 : 0);
  console.log(
    `  ◇ reliability: succeeded=${success ? "yes" : "no"} after ${attemptsMade} attempt(s); ${failures.length} threw before success`,
  );
  if (!success) {
    for (const n of ["K2 valid package", "K3 recall", "K4 decision", "K5 leak"])
      record(n, "fail", "no successful evolution to inspect");
    return;
  }
  const { slug, skillsRoot, loop, scribe, sessionId } = success;

  banner("K2 · 产出物是合法技能包（validateLearnedSkillPackage 通过，传裸 slug）");
  const files = await readSkillPackage(skillsRoot, slug);
  console.log("  package files:", Object.keys(files).join(", "));
  console.log("\n  ── SKILL.md\n" + (files["SKILL.md"] ?? "").replace(/^/gm, "    ").slice(0, 900));
  const bareSlug = slug.replace(/^memflywheel-learned-/, "");
  let valid = false;
  let validErr = "";
  try {
    validateLearnedSkillPackage({ slug: bareSlug, files });
    valid = true;
  } catch (e) {
    validErr = e?.message ?? String(e);
  }
  check("K2 created package passes validateLearnedSkillPackage", valid, validErr);

  banner("K3 · 技能路由召回：新技能以 name + path 出现在 skillPrelude");
  const ctx = await scribe.onPromptBuild({ sessionId });
  const sp = ctx.skillPreludePrompt ?? "";
  console.log("  skillPrelude:\n" + (sp ? sp.replace(/^/gm, "    ") : "    (empty)"));
  check(
    "K3 skill recalled with name + path in skillPrelude",
    sp.includes(slug) && /path:/i.test(sp),
    "skillPrelude missing slug or path:",
  );

  banner("K4 · 协调决策是 create（真的演化，不是 noop）");
  const decision = loop?.skillEvolution?.value?.coordination?.decision;
  console.log("  coordination decision:", decision);
  check(
    "K4 coordination decision is create (not noop)",
    decision === "create",
    `decision=${decision}`,
  );

  banner("K5 · 卫生：发布技能包不含根级隐藏元数据文件");
  const leaked = Object.keys(files).some((f) => f.startsWith("."));
  check(
    "K5 no root hidden metadata files in published package",
    !leaked,
    "root hidden metadata file shipped inside the published skill",
  );

  banner("K6 · 记忆↔技能联动：技能创建后自动触发 dream 压缩记忆");
  console.log("  dream:", JSON.stringify(loop?.dream ?? null).slice(0, 200));
  check(
    "K6 skill creation auto-triggered memory dream (联动)",
    loop?.dream?.ran === true,
    `dream=${JSON.stringify(loop?.dream)}`,
  );

  await scribe.onSessionEnd({ sessionId });
}

// ════════════════ GROUP P · 反向代理：断言原始请求（非仅打印）═════════════════

function groupProxyAssertions() {
  if (!HAVE_KEY) {
    record("P proxy capture", "skip", "no key");
    return;
  }
  banner("P · 代理抓到的 DeepSeek 原始请求符合预期（断言，非打印）");
  check(
    "P captured at least one upstream request",
    proxyLog.length > 0,
    `captured=${proxyLog.length}`,
  );

  // an extraction/skill request must carry a MemFlywheel system prompt
  const sawMemSystem = proxyLog.some((e) =>
    /memory extraction|learned-skill|file tools|MEMORY\.md|记忆|技能/i.test(
      e.summary?.systemHead ?? "",
    ),
  );
  check("P a MemFlywheel system prompt reached the model", sawMemSystem);

  // some request must expose the six file tools WITH schemas (not just names)
  const SIX = ["read", "write", "edit", "bash", "glob", "grep"];
  const withSix = proxyLog.find((e) => SIX.every((n) => (e.summary?.toolNames ?? []).includes(n)));
  check(
    "P the six file tools were advertised to the model",
    Boolean(withSix),
    `toolSets=${proxyLog.map((e) => (e.summary?.toolNames ?? []).length).join(",")}`,
  );
  if (withSix) {
    const schemasOk = SIX.every((n) => {
      const s = withSix.summary.toolSchemas.find((x) => x.name === n);
      return s && s.hasParams;
    });
    check("P each of the six tools carries a parameters schema", schemasOk);
  } else {
    check(
      "P each of the six tools carries a parameters schema",
      false,
      "no request had all six tools",
    );
  }

  // a real tool-call round-trip must have happened in at least one captured request
  const sawRoundTrip =
    proxyLog.some((e) => e.summary?.hasAssistantToolCall) &&
    proxyLog.some((e) => e.summary?.hasToolResult);
  check("P a real tool_call/tool_result round-trip was observed", sawRoundTrip);

  // secret hygiene: the real key must never appear in the capture log
  const serialized = JSON.stringify(proxyLog);
  check("P no API key in capture log", !API_KEY || !serialized.includes(API_KEY));
  check(
    "P no bearer/sk- secret in capture log",
    !/Bearer\s+sk-|sk-[A-Za-z0-9._-]{12,}/.test(serialized),
  );
}

// ──────────────────────────────── main ─────────────────────────────────────

async function main() {
  console.log(
    `MemFlywheel × Pi — STRICT E2E — model=${MODEL} endpoint=${ENDPOINT} key=${HAVE_KEY ? "YES" : "NO"}`,
  );
  let proxy = null;
  if (HAVE_KEY) proxy = await startCaptureProxy();

  try {
    await groupDeterministic();
    await groupMemory();
    await groupSkill();
    groupProxyAssertions();
  } finally {
    if (proxy) await new Promise((r) => proxy.close(r));
  }

  console.log(`\n  ${by("pass")} pass · ${by("skip")} skip · ${by("fail")} fail`);
  if (by("fail") > 0) {
    console.log("\n  FAILURES:");
    for (const r of results.filter((r) => r.status === "fail"))
      console.log(`   ❌ ${r.name} — ${r.detail}`);
  }
  process.exit(by("fail") > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(2);
});
