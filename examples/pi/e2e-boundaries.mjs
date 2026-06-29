/**
 * MemFlywheel × Pi — 10 boundary E2E scenarios (real model) + request/response capture proxy.
 *
 * Hard pass/fail only (no warn). A reverse proxy in front of the model captures BOTH the
 * raw request and the raw response for every upstream call, classifies it (extraction /
 * skill / dream), redacts secrets, writes a JSONL transcript to a temp file, and prints a
 * per-kind digest so you can read exactly what the model sees and returns — for tuning.
 *
 * SECURITY: key from env only; never hardcoded; redacted out of the capture transcript.
 *
 *   export MEMFLYWHEEL_LLM_API_KEY=sk-...
 *   export MEMFLYWHEEL_LLM_ENDPOINT=https://api.deepseek.com/v1
 *   export MEMFLYWHEEL_LLM_MODEL=deepseek-v4-flash
 *   node examples/pi/e2e-boundaries.mjs
 */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMemFlywheelHarnessRuntime,
  createPiHarnessPort,
  classifyHostCapabilities,
} from "@memflywheel/adapters";
import { createOpenAIChatCompletionsModel } from "@memflywheel/model";
import { validateLearnedSkillPackage, createLearnedSkillStore } from "@memflywheel/skills";

// ───────────────────────────── config ──────────────────────────────────────

const ENDPOINT = process.env.MEMFLYWHEEL_LLM_ENDPOINT ?? "https://api.deepseek.com/v1";
const MODEL = process.env.MEMFLYWHEEL_LLM_MODEL ?? "deepseek-v4-flash";
const API_KEY =
  process.env.MEMFLYWHEEL_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
const HAVE_KEY = Boolean(API_KEY);
let ACTIVE_ENDPOINT = ENDPOINT;
let ACTIVE_API_KEY = API_KEY;

function buildModel() {
  return createOpenAIChatCompletionsModel({
    endpoint: ACTIVE_ENDPOINT,
    apiKey: ACTIVE_API_KEY,
    model: MODEL,
    maxTokens: 4096,
    temperature: 0,
  });
}

// ─────────────────────────── results ───────────────────────────────────────

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : `  — ${detail || "failed"}`}`);
}
const check = (name, cond, detail = "") => record(name, Boolean(cond), detail);
const banner = (t) => console.log(`\n── ${t}`);
const passed = () => results.filter((r) => r.ok).length;
const failed = () => results.filter((r) => !r.ok).length;

// ─────────────────────── capture proxy (req + resp) ─────────────────────────

const capture = []; // { kind, request, response }

function redact(value) {
  if (typeof value === "string") {
    let out = value;
    if (API_KEY) out = out.split(API_KEY).join("[KEY]");
    return out
      .replace(/Bearer\s+sk-[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9._-]{12,}/g, "[SECRET]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = /authorization|api[_-]?key|token|secret/i.test(k) ? "[REDACTED]" : redact(v);
    return out;
  }
  return value;
}

function classifyKind(body) {
  const system =
    (Array.isArray(body?.messages) ? body.messages : []).find((m) => m?.role === "system")
      ?.content ?? "";
  if (/long-term memory extraction engine/i.test(system)) return "extraction";
  if (/learned-skill evolution agent/i.test(system)) return "skill";
  if (/Dream reviews the WHOLE store|dream/i.test(system)) return "dream";
  return "other";
}

function summarizeRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    model: body?.model,
    roles: messages.map((m) => m?.role),
    systemHead: redact(
      String(messages.find((m) => m?.role === "system")?.content ?? "").slice(0, 600),
    ),
    lastUserHead: redact(
      String([...messages].reverse().find((m) => m?.role === "user")?.content ?? "").slice(0, 400),
    ),
    tools: tools.map((t) => ({
      name: t?.function?.name ?? t?.name,
      params: Object.keys((t?.function?.parameters ?? {}).properties ?? {}),
    })),
  };
}

function summarizeResponse(json) {
  const choice = json?.choices?.[0]?.message ?? {};
  return {
    finishReason: json?.choices?.[0]?.finish_reason,
    content: redact(
      typeof choice.content === "string" ? choice.content.slice(0, 600) : choice.content,
    ),
    toolCalls: (choice.tool_calls ?? []).map((c) => ({
      name: c?.function?.name,
      args: redact(String(c?.function?.arguments ?? "").slice(0, 300)),
    })),
    usage: json?.usage,
  };
}

async function startProxy() {
  const upstream = new URL(ENDPOINT.replace(/\/+$/, ""));
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
      const suffix = (req.url ?? "").replace(/^\/v1(?=\/|$)/, "");
      const upstreamReq = https.request(
        {
          hostname: upstream.hostname,
          port: 443,
          path: `${upstream.pathname.replace(/\/+$/, "")}${suffix}`,
          method: req.method,
          headers: { ...req.headers, host: upstream.hostname, authorization: `Bearer ${API_KEY}` },
        },
        (up) => {
          const respChunks = [];
          up.on("data", (c) => respChunks.push(c));
          up.on("end", () => {
            const respRaw = Buffer.concat(respChunks).toString("utf8");
            let respJson;
            try {
              respJson = JSON.parse(respRaw);
            } catch {
              respJson = undefined;
            }
            capture.push({
              kind: classifyKind(body),
              request: summarizeRequest(body),
              response: respJson
                ? summarizeResponse(respJson)
                : { raw: redact(respRaw.slice(0, 600)) },
            });
            res.writeHead(up.statusCode ?? 502, up.headers);
            res.end(Buffer.concat(respChunks));
          });
        },
      );
      upstreamReq.on("error", (e) => {
        res.writeHead(502);
        res.end(JSON.stringify({ error: e.message }));
      });
      upstreamReq.end(raw);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ACTIVE_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1`;
  ACTIVE_API_KEY = "memflywheel-local-proxy-token";
  return server;
}

// ──────────────────────────── fs helpers ───────────────────────────────────

async function walk(dir, rel = "") {
  const out = [];
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), r)));
    else out.push({ rel, abs: path.join(dir, e.name), name: r });
  }
  return out;
}
const readSafe = (p) => readFile(p, "utf8").catch(() => "");
async function dumpRoot(root) {
  const files = await walk(root);
  return { files, index: await readSafe(path.join(root, "MEMORY.md")) };
}
const tmp = (p) => mkdtemp(path.join(tmpdir(), p));

// ──────────────────────────── transcripts ──────────────────────────────────

const VALID_TYPES = ["identity", "preference", "style", "workflow", "context", "ambient"];

const facts = [
  { role: "user", text: "我叫 Kai,后端工程师,咖啡只喝美式,回复请简洁,项目部署在 ap-singapore。" },
  { role: "assistant", text: "记下了 Kai:后端、美式、简洁、ap-singapore。" },
];
const secret = [
  {
    role: "user",
    text:
      "存下发布习惯:用 GitHub Actions。token 是 " + "sk-" + "BOUNDARY0123456789ABCD(别存这个)。",
  },
  { role: "assistant", text: "好的,习惯已记,凭据不保存。" },
];
const chitchat = [
  { role: "user", text: "今天天气不错,随便聊聊。" },
  { role: "assistant", text: "是啊,适合散步。" },
];
const releaseProcedure = [
  { role: "user", text: "把这个 monorepo 发个版,记成以后能照做的标准流程。" },
  {
    role: "assistant",
    text: "开始,先构建。",
    toolCalls: [{ name: "bash", input: { command: "pnpm -r build" }, output: "8 packages built" }],
  },
  {
    role: "assistant",
    text: "构建过,跑测试。",
    toolCalls: [{ name: "bash", input: { command: "pnpm -r test" }, output: "240 passed" }],
  },
  {
    role: "assistant",
    text: "改 changelog。",
    toolCalls: [
      { name: "edit", input: { filePath: "CHANGELOG.md", text: "## 0.2.0" }, output: "edited" },
      { name: "bash", input: { command: "git add CHANGELOG.md" }, output: "staged" },
    ],
  },
  {
    role: "assistant",
    text: "发布并打 tag。",
    toolCalls: [
      { name: "bash", input: { command: "pnpm -r publish" }, output: "published" },
      { name: "bash", input: { command: "git tag v0.2.0 && git push --tags" }, output: "tagged" },
    ],
  },
  { role: "user", text: "以后每次发版都这样走。" },
  { role: "assistant", text: "已确认:构建→测试→改 changelog→发布→打 tag,固定流程。" },
];

function skillRuntime(root, skillsRoot, ckptRoot, gate) {
  return createMemFlywheelHarnessRuntime({
    model: buildModel(),
    root,
    learnedSkills: { skillsRoot, checkpointRoot: ckptRoot },
    learningLoop: { gate },
  });
}

// ═══════════════════════════════ scenarios ═════════════════════════════════

async function b1_recallOnly() {
  banner("B1 · recall-only 模式:能召回、不需要模型、不抽取");
  const root = await tmp("ms-b1-");
  const { scribe, mode } = createMemFlywheelHarnessRuntime({ root, mode: "recall-only" });
  check("B1 mode === recall-only", mode === "recall-only", `mode=${mode}`);
  await scribe.onSessionStart({ sessionId: "b1" });
  const ctx = await scribe.onPromptBuild({ sessionId: "b1" });
  check("B1 prompt-build returns a context", typeof ctx?.enabled === "boolean");
}

async function b2_failFast() {
  banner("B2 · fail-fast:无 model 且非 recall-only → 抛错,不静默降级");
  const root = await tmp("ms-b2-");
  let threw = false;
  try {
    createMemFlywheelHarnessRuntime({ root });
  } catch (e) {
    threw = /canonical model|extraction agent/i.test(e?.message ?? "");
  }
  check("B2 throws without a model", threw);
}

async function b3_capability() {
  banner("B3 · 能力分级:Pi port → skill-loop,且具备 tool-trajectory");
  const stubPi = { on: () => () => {}, off: () => {} };
  const completeSimple = async () => ({ role: "assistant", content: [{ type: "text", text: "" }] });
  const port = createPiHarnessPort(stubPi, { completeSimple });
  check("B3 classify === skill-loop", classifyHostCapabilities(port.capabilities) === "skill-loop");
  check("B3 has tool-trajectory capability", port.capabilities.has("tool-trajectory"));
}

async function b4_extraction() {
  banner("B4 · turn-end 抽取:写出 typed 文件 + 合法 frontmatter.type + MEMORY.md 同步");
  const root = await tmp("ms-b4-");
  const { scribe } = createMemFlywheelHarnessRuntime({ model: buildModel(), root });
  await scribe.onSessionStart({ sessionId: "b4" });
  const turn = await scribe.onTurnEnd({ sessionId: "b4", messages: facts });
  check("B4 extraction completed", turn?.result === "completed", `result=${turn?.result}`);
  const dump = await dumpRoot(root);
  const mem = dump.files.filter((f) => f.name.endsWith(".md") && f.name !== "MEMORY.md");
  check("B4 a memory file written", mem.length > 0, dump.files.map((f) => f.name).join(","));
  let typedOk = mem.length > 0;
  for (const f of mem) {
    const top = f.name.split("/")[0];
    const t = (await readSafe(f.abs)).match(/^type:\s*(\S+)/m)?.[1];
    if (!VALID_TYPES.includes(top) || !VALID_TYPES.includes(t)) typedOk = false;
  }
  check("B4 every file in a valid typed dir with valid type", typedOk);
  check("B4 MEMORY.md non-empty", dump.index.trim().length > 0);
  return root;
}

async function b5_recall(root) {
  banner("B5 · 跨轮召回:上轮记忆作为索引注入下轮 prompt(不是正文)");
  const { scribe } = createMemFlywheelHarnessRuntime({ model: buildModel(), root });
  const ctx = await scribe.onPromptBuild({ sessionId: "b4" });
  const text = `${ctx.systemPrompt ?? ""}\n${ctx.preludePrompt ?? ""}`;
  const signals = [/美式|coffee|偏好/i, /简洁|style|风格/i, /Kai|身份/i, /singapore|部署/i].filter(
    (re) => re.test(text),
  ).length;
  check("B5 prior memory recalled (>=2 signals)", signals >= 2, `signals=${signals}`);
  check("B5 prelude is an index, not raw bodies", /可用记忆|Available memories|- \[/i.test(text));
}

async function b6_privacy() {
  banner("B6 · 隐私:transcript 里的 secret 永不落盘");
  const root = await tmp("ms-b6-");
  const { scribe } = createMemFlywheelHarnessRuntime({ model: buildModel(), root });
  await scribe.onSessionStart({ sessionId: "b6" });
  await scribe.onTurnEnd({ sessionId: "b6", messages: secret });
  const dump = await dumpRoot(root);
  const all = (await Promise.all(dump.files.map((f) => readSafe(f.abs)))).join("\n") + dump.index;
  check("B6 secret NOT persisted to disk", !new RegExp("sk-" + "BOUNDARY0123456789").test(all));
}

async function b7_dream() {
  banner("B7 · idle → dream:运行、索引仍可用、记忆未丢");
  const root = await tmp("ms-b7-");
  const { scribe } = createMemFlywheelHarnessRuntime({ model: buildModel(), root });
  await scribe.onSessionStart({ sessionId: "b7" });
  await scribe.onTurnEnd({ sessionId: "b7", messages: facts });
  const before = (await dumpRoot(root)).files.filter(
    (f) => f.name.endsWith(".md") && f.name !== "MEMORY.md",
  ).length;
  let err = null;
  try {
    await scribe.onIdle({ force: true });
  } catch (e) {
    err = e?.message ?? String(e);
  }
  const after = await dumpRoot(root);
  const afterN = after.files.filter((f) => f.name.endsWith(".md") && f.name !== "MEMORY.md").length;
  check("B7 dream ran without throwing", err === null, err ?? "");
  check(
    "B7 index parseable, memories preserved",
    typeof after.index === "string" && afterN >= 1 && afterN <= before,
    `before=${before} after=${afterN}`,
  );
}

async function b8_skillCreate() {
  banner("B8 · 技能闭环:富轨迹 → 合法技能包 + 召回 + decision=create + 不泄漏 + dream 联动");
  const MAX = 4;
  let ok = null,
    lastErr = "";
  for (let i = 1; i <= MAX && !ok; i += 1) {
    const root = await tmp("ms-b8-"),
      skillsRoot = await tmp("ms-b8-s-"),
      ckpt = await tmp("ms-b8-c-");
    await mkdir(skillsRoot, { recursive: true });
    const { scribe } = skillRuntime(root, skillsRoot, ckpt, {
      minDoneTurns: 1,
      cooldownTurns: 0,
      minToolCalls: 6,
    });
    await scribe.onSessionStart({ sessionId: "b8" });
    try {
      const t = await scribe.onTurnEnd({ sessionId: "b8", messages: releaseProcedure });
      const slugs = (await readdir(skillsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (slugs.length === 1) {
        ok = { scribe, skillsRoot, slug: slugs[0], loop: t?.learningLoop };
      } else lastErr = `slugs=[${slugs.join(",")}]`;
    } catch (e) {
      lastErr = e?.message ?? String(e);
    }
    if (!ok) console.log(`  attempt ${i}: ${lastErr}`);
  }
  check("B8 produced a learned skill (<=4 attempts)", Boolean(ok), lastErr);
  if (!ok) {
    for (const n of [
      "B8 valid package",
      "B8 recalled",
      "B8 decision=create",
      "B8 package hygiene",
      "B8 dream 联动",
    ])
      record(n, false, "no skill");
    return;
  }
  const files = {};
  for (const f of await readdir(path.join(ok.skillsRoot, ok.slug)))
    files[f] = await readSafe(path.join(ok.skillsRoot, ok.slug, f));
  let valid = false,
    ve = "";
  try {
    validateLearnedSkillPackage({ slug: ok.slug.replace(/^memflywheel-learned-/, ""), files });
    valid = true;
  } catch (e) {
    ve = e?.message ?? String(e);
  }
  check("B8 valid package (validateLearnedSkillPackage)", valid, ve);
  const sp = (await ok.scribe.onPromptBuild({ sessionId: "b8" })).skillPreludePrompt ?? "";
  check("B8 recalled in skillPrelude (name + path)", sp.includes(ok.slug) && /path:/i.test(sp));
  check(
    "B8 decision === create",
    ok.loop?.skillEvolution?.value?.coordination?.decision === "create",
    `decision=${ok.loop?.skillEvolution?.value?.coordination?.decision}`,
  );
  check(
    "B8 package has no root hidden metadata files",
    !Object.keys(files).some((f) => f.startsWith(".")),
  );
  check(
    "B8 dream 联动 fired (memory↔skill)",
    ok.loop?.dream?.ran === true,
    `dream=${JSON.stringify(ok.loop?.dream)}`,
  );
}

async function b9_gateBlocks() {
  banner("B9 · 不触发边界:不够格的轮次不跑技能演化(两道闸)");
  // B9a: 闲聊 → 抽取无可记内容(Skipped) → 前置闸 extraction-not-completed
  {
    const root = await tmp("ms-b9a-"),
      skillsRoot = await tmp("ms-b9a-s-"),
      ckpt = await tmp("ms-b9a-c-");
    await mkdir(skillsRoot, { recursive: true });
    const { scribe } = createMemFlywheelHarnessRuntime({
      model: buildModel(),
      root,
      learnedSkills: { skillsRoot, checkpointRoot: ckpt },
    });
    await scribe.onSessionStart({ sessionId: "b9a" });
    const t = await scribe.onTurnEnd({ sessionId: "b9a", messages: chitchat });
    const reason = t?.learningLoop?.skillEvolution?.reason;
    check(
      "B9a chitchat → skill skipped (extraction-not-completed)",
      t?.learningLoop?.skillEvolution?.ran === false &&
        /extraction-not-completed|min-/.test(reason ?? ""),
      `reason=${reason}`,
    );
  }
  // B9b: 有可记内容但首轮(doneTurns=1 < minDoneTurns=3) → 门控闸 min-done-turns
  {
    const root = await tmp("ms-b9b-"),
      skillsRoot = await tmp("ms-b9b-s-"),
      ckpt = await tmp("ms-b9b-c-");
    await mkdir(skillsRoot, { recursive: true });
    const { scribe } = createMemFlywheelHarnessRuntime({
      model: buildModel(),
      root,
      learnedSkills: { skillsRoot, checkpointRoot: ckpt },
    });
    await scribe.onSessionStart({ sessionId: "b9b" });
    const t = await scribe.onTurnEnd({ sessionId: "b9b", messages: facts });
    const reason = t?.learningLoop?.skillEvolution?.reason;
    check(
      "B9b first meaningful turn → blocked by gate",
      t?.learningLoop?.skillEvolution?.ran === false &&
        /min-done-turns|min-tool-calls|cooldown/.test(reason ?? ""),
      `reason=${reason}`,
    );
    const slugs = (await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])).filter((d) =>
      d.isDirectory(),
    );
    check("B9b no skill produced when gated", slugs.length === 0);
  }
}

async function b10_sandbox() {
  banner("B10 · 沙箱边界:技能 store 的 bash 拒绝绝对路径(防越界写 skillsRoot)");
  const root = await tmp("ms-b10-");
  const store = createLearnedSkillStore({
    skillsRoot: path.join(root, "skills"),
    checkpointRoot: path.join(root, "ckpt"),
  });
  const checkpoint = await store.createSkillCheckpoint();
  const bash = store.createFileTools(checkpoint).find((t) => t.name === "bash");
  const abs = await bash.handler({ command: `cat > ${root}/skills/x/SKILL.md << 'EOF'\nhi\nEOF` });
  check(
    "B10 bash rejects an absolute path",
    abs.ok === false && /relative paths only|absolute/i.test(abs.text),
    abs.text?.slice(0, 80),
  );
  const rel = await bash.handler({ command: "mkdir -p memflywheel-learned-x" });
  check("B10 bash allows a relative path", rel.ok === true, rel.text?.slice(0, 80));
}

// ──────────────────────── capture digest ───────────────────────────────────

async function dumpCapture() {
  if (!HAVE_KEY || capture.length === 0) return;
  const file = path.join(await tmp("ms-capture-"), "model-traffic.jsonl");
  await writeFile(file, capture.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
  const byKind = capture.reduce((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  console.log(`\n── 模型原始流量(已脱敏):${capture.length} 次调用 ${JSON.stringify(byKind)}`);
  console.log(`   全量 JSONL: ${file}`);
  for (const kind of ["extraction", "skill", "dream"]) {
    const sample = capture.find((c) => c.kind === kind);
    if (!sample) continue;
    console.log(`\n   ▼ ${kind} 样本`);
    console.log(`     req.tools = [${sample.request.tools.map((t) => t.name).join(", ")}]`);
    console.log(
      `     req.system(head) = ${JSON.stringify(sample.request.systemHead.slice(0, 140))}`,
    );
    console.log(
      `     resp.finish = ${sample.response.finishReason}; toolCalls = [${(sample.response.toolCalls ?? []).map((t) => t.name).join(", ")}]`,
    );
    console.log(
      `     resp.content(head) = ${JSON.stringify(String(sample.response.content ?? "").slice(0, 160))}`,
    );
  }
}

// ──────────────────────────────── main ─────────────────────────────────────

async function main() {
  console.log(
    `MemFlywheel × Pi — 10 BOUNDARY E2E — model=${MODEL} endpoint=${ENDPOINT} key=${HAVE_KEY ? "YES" : "NO"}`,
  );
  let proxy = null;
  if (HAVE_KEY) proxy = await startProxy();
  try {
    await b1_recallOnly();
    await b2_failFast();
    await b3_capability();
    await b10_sandbox();
    if (!HAVE_KEY) {
      for (const n of [
        "B4 extraction",
        "B5 recall",
        "B6 privacy",
        "B7 dream",
        "B8 skill",
        "B9 gate",
      ])
        record(n, false, "no key (set MEMFLYWHEEL_LLM_API_KEY)");
    } else {
      const root = await b4_extraction();
      await b5_recall(root);
      await b6_privacy();
      await b7_dream();
      await b8_skillCreate();
      await b9_gateBlocks();
    }
  } finally {
    if (proxy) await new Promise((r) => proxy.close(r));
  }
  await dumpCapture();
  console.log(`\n  ${passed()} pass · ${failed()} fail`);
  if (failed() > 0) for (const r of results.filter((r) => !r.ok)) console.log(`   ❌ ${r.name}`);
  process.exit(failed() > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(2);
});
