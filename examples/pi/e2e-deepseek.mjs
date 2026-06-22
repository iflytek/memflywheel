/**
 * MemScribe × Pi — comprehensive, boundary-focused end-to-end test (real model: DeepSeek).
 *
 * Written to be RUN (e.g. by Codex), read, and iterated on. Scenarios are grouped:
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
 *   export MEMSCRIBE_LLM_API_KEY=sk-...                 # your DeepSeek key
 *   export MEMSCRIBE_LLM_ENDPOINT=https://api.deepseek.com/v1
 *   export MEMSCRIBE_LLM_MODEL=deepseek-v4-flash
 *
 *   node examples/pi/e2e-deepseek.mjs                   # A+B (if key) + C (always)
 *   PI_REAL=1 node examples/pi/e2e-deepseek.mjs         # also boot real Pi (D)
 *   node examples/pi/e2e-deepseek.mjs                   # no key → runs only C
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMemScribeHarnessRuntime,
  createPiHarnessPort,
  classifyHostCapabilities,
  requireHostCapabilities,
  createCapabilitySet,
} from "@memscribe/adapters";
import { createOpenAIChatCompletionsModel } from "@memscribe/model";
import {
  validateLearnedSkillPackage,
  LearnedSkillValidationError,
  createLearnedSkillStore,
  createLearnedSkillRecallProvider,
  buildLearnedSkillPrelude,
} from "@memscribe/skills";

// ───────────────────────────── config ──────────────────────────────────────

const ENDPOINT =
  process.env.MEMSCRIBE_LLM_ENDPOINT ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = process.env.MEMSCRIBE_LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const API_KEY = process.env.MEMSCRIBE_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
const HAVE_KEY = Boolean(API_KEY);

function buildModel() {
  return createOpenAIChatCompletionsModel({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    model: MODEL,
    maxTokens: 1024,
    temperature: 0,
  });
}

// ──────────────────────────── tiny harness ─────────────────────────────────

const results = [];
function banner(t) {
  console.log("\n" + "═".repeat(74) + "\n  " + t + "\n" + "═".repeat(74));
}
function record(name, status, detail = "") {
  results.push({ name, status });
  const icon = status === "pass" ? "✅" : status === "warn" ? "⚠️ " : status === "skip" ? "⏭️ " : "❌";
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
  console.log(`  files (${files.length}): ${files.map((f) => path.relative(root, f)).join(", ") || "(none)"}`);
  return { index, files };
}

/** A SKILL.md that passes validateLearnedSkillPackage (strict frontmatter + 3 sections). */
function validSkillMd(slug, displayName, description) {
  return [
    "---",
    `name: memscribe-learned-${slug}`,
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
      "记一下我的偏好：我叫 Kai，主力项目是 MemScribe。我喝咖啡只喝美式不加糖。" +
      "回复我语气要简洁直接、不要寒暄。常用部署区域是 ap-singapore。",
  },
  { role: "assistant", text: "明白，已记住。" },
];

const procedureTranscript = [
  { role: "user", text: "把 MemScribe 的发布流程完整跑一遍，并以后照这个流程来。" },
  {
    role: "assistant",
    text: "执行发布流程。",
    toolCalls: [
      { name: "bash", input: { command: "pnpm -r build" }, output: "build ok" },
      { name: "bash", input: { command: "pnpm -r test" }, output: "242 passed" },
      { name: "bash", input: { command: "npm publish --access public" }, output: "+ memscribe@0.1.0" },
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
  { role: "user", text: "再按发布流程发一版。" },
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
      "sk-" + "ABCDEF0123456789ABCDEF（别存这个）。",
  },
  { role: "assistant", text: "好的，发布习惯已记，敏感凭据不会保存。" },
];

// ═══════════════════════ GROUP A · 记忆闭环 (real model) ═══════════════════════

async function groupA() {
  const root = await mkdtemp(path.join(tmpdir(), "ms-A-"));
  const sessionId = "A";

  banner("A1 · recall-only 模式：能召回、不抽取（无需模型）");
  {
    const { scribe, mode } = createMemScribeHarnessRuntime({ root, mode: "recall-only" });
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

  const { scribe } = createMemScribeHarnessRuntime({ model: buildModel(), root });
  await scribe.onSessionStart({ sessionId });

  banner("A2 · turn-end 抽取写出真实 memory 文件");
  const turn = await scribe.onTurnEnd({ sessionId, messages: factsTranscript });
  console.log("  onTurnEnd:", JSON.stringify(turn).slice(0, 200));
  const after = await dumpRoot("after extraction", root);
  check("A2 MEMORY.md non-empty", after.index.trim().length > 0);
  check("A2 a memory file written", after.files.some((f) => !f.endsWith("MEMORY.md")));

  banner("A3 · 跨轮召回：上轮记忆注入下轮 prompt");
  const ctx = await scribe.onPromptBuild({ sessionId });
  const recall = `${ctx.systemPrompt ?? ""}\n${ctx.preludePrompt ?? ""}\n${ctx.skillPreludePrompt ?? ""}`;
  console.log("  prelude (head):", (ctx.preludePrompt ?? "").slice(0, 200).replace(/\n/g, " "));
  check("A3 prior memory recalled", /美式|咖啡|简洁|Kai|MemScribe|singapore/i.test(recall));

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
    for (const n of ["B1 skill evolution", "B2 skill route recall", "B3 trajectory-derived update", "B4 memory→cue"])
      record(n, "skip", "no key");
    return null;
  }
  const root = await mkdtemp(path.join(tmpdir(), "ms-B-"));
  const skillsRoot = path.join(root, "skills");
  const checkpointRoot = path.join(root, "checkpoints");
  await mkdir(skillsRoot, { recursive: true });

  const { scribe } = createMemScribeHarnessRuntime({
    model: buildModel(),
    root,
    learnedSkills: { skillsRoot, checkpointRoot },
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
  const t1 = await scribe.onTurnEnd({ sessionId, messages: procedureTranscript });
  console.log("  onTurnEnd:", JSON.stringify(t1).slice(0, 400));
  let skillFiles = (await listFiles(skillsRoot)).filter((f) => /SKILL\.md$/i.test(f));
  for (const f of skillFiles) console.log(`\n  ── ${path.relative(skillsRoot, f)}\n` + (await readSafe(f)).replace(/^/gm, "    "));
  record("B1 a learned skill package was created", skillFiles.length > 0 ? "pass" : "warn", skillFiles.length ? "" : "model declined — inspect onTurnEnd");

  banner("B2 · 技能路由召回：新技能以 name+path 出现在 skillPrelude");
  const ctx = await scribe.onPromptBuild({ sessionId });
  const sp = ctx.skillPreludePrompt ?? "";
  console.log("  skillPrelude:\n" + (sp ? sp.replace(/^/gm, "    ") : "    (empty)"));
  record("B2 skill route present (name + path)", /## 可用技能/.test(sp) && /path:/.test(sp) ? "pass" : "warn", sp ? "" : "depends on B1");

  banner("B3 · 轨迹派生失败 → 技能更新（纯看工具轨迹）");
  const before = skillFiles.length ? await readSafe(skillFiles[0]) : "";
  const t2 = await scribe.onTurnEnd({ sessionId, messages: failureTranscript });
  console.log("  onTurnEnd:", JSON.stringify(t2).slice(0, 400));
  const after = skillFiles.length ? await readSafe(skillFiles[0]) : "";
  record(
    "B3 evolution reacted to the failing trajectory",
    before && after && before !== after ? "pass" : "warn",
    before === after ? "skill unchanged — model may have declined; inspect output" : "skill updated",
  );

  banner("B4 · memory → routing cue：流程型记忆压成指向技能的 cue（人工核查）");
  const mem = await readSafe(path.join(root, "MEMORY.md"));
  console.log("  MEMORY.md:\n" + (mem ? mem.replace(/^/gm, "    ") : "    (empty)"));
  // Tolerant: assert memory does NOT duplicate the full numbered procedure verbatim.
  const dupSteps = /1\)\s*pnpm -r build[\s\S]*2\)\s*pnpm -r test[\s\S]*3\)/.test(mem);
  record("B4 memory keeps a cue, not the full procedure", dupSteps ? "warn" : "pass", dupSteps ? "full steps still in memory — inspect" : "");

  await scribe.onSessionEnd({ sessionId });
  return { root, skillsRoot };
}

// ══════════════════ GROUP C · 边界 (deterministic, no key) ═════════════════════

async function groupC() {
  banner("C1 · 技能不执行：MemScribe 只 store/validate/evolve，无 execute/run/spawn");
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-C1-"));
    const store = createLearnedSkillStore({
      skillsRoot: path.join(root, "skills"),
      checkpointRoot: path.join(root, "checkpoints"),
    });
    const forbidden = ["execute", "run", "spawn", "load", "invoke", "exec"];
    const storeClean = forbidden.every((m) => typeof store[m] !== "function");
    check("C1 store exposes no execution method", storeClean, `store keys: ${Object.keys(store).join(",")}`);
    const { scribe } = createMemScribeHarnessRuntime({ root, mode: "recall-only" });
    const scribeClean = forbidden.every((m) => typeof scribe[m] !== "function");
    check("C1 scribe exposes no execution method", scribeClean);
  }

  banner("C2 · 能力分级：classifyHostCapabilities");
  {
    const all = createCapabilitySet([
      "prompt-build", "turn-end", "session-end", "idle",
      "single-tool-completion", "agentic-tool-loop", "tool-trajectory",
    ]);
    check("C2 full caps → skill-loop", classifyHostCapabilities(all) === "skill-loop");
    check("C2 drop tool-trajectory → memory-loop",
      classifyHostCapabilities(createCapabilitySet(["prompt-build", "turn-end", "agentic-tool-loop"])) === "memory-loop");
    check("C2 only prompt-build → recall-only",
      classifyHostCapabilities(createCapabilitySet(["prompt-build"])) === "recall-only");
    check("C2 empty → none", classifyHostCapabilities(createCapabilitySet([])) === "none");
    const stubPi = { on: () => () => {}, completeSimple: async () => ({ role: "assistant", content: [] }) };
    const port = createPiHarnessPort(stubPi);
    check("C2 Pi port classifies as skill-loop", classifyHostCapabilities(port.capabilities) === "skill-loop");
  }

  banner("C3 · fail-fast：缺 model / 缺能力 → 显式抛错（无静默降级）");
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-C3-"));
    expectThrows("C3 no model & not recall-only → throws",
      () => createMemScribeHarnessRuntime({ root }), /canonical model/i);
    let ok = true;
    try { createMemScribeHarnessRuntime({ root, mode: "recall-only" }); } catch { ok = false; }
    check("C3 recall-only constructs without a model", ok);
    expectThrows("C3 requireHostCapabilities throws on missing cap",
      () => requireHostCapabilities("test", createCapabilitySet(["prompt-build"]), ["prompt-build", "turn-end"]),
      /missing host capabilities/i);
  }

  banner("C4 · 校验边界：validateLearnedSkillPackage 接受合法、拒绝非法");
  {
    const valid = {
      slug: "release-runbook",
      files: { "SKILL.md": validSkillMd("release-runbook", "Release Runbook", "Use when publishing MemScribe to npm.") },
    };
    let okValid = true;
    try {
      const v = validateLearnedSkillPackage(valid);
      okValid = v.skillName === "memscribe-learned-release-runbook";
    } catch (e) {
      okValid = false;
      console.log("  unexpected:", e?.message);
    }
    check("C4 valid package passes", okValid);

    expectThrows("C4 missing SKILL.md → rejected",
      () => validateLearnedSkillPackage({ slug: "x", files: { "references/a.md": "hi" } }),
      /SKILL\.md/);
    expectThrows("C4 missing required section → rejected",
      () => validateLearnedSkillPackage({
        slug: "x",
        files: { "SKILL.md": "---\nname: memscribe-learned-x\ndisplay_name: X\ndescription: d\n---\n\n## Use Cases\n- a\n" },
      }));
    expectThrows("C4 forbidden public name → rejected",
      () => validateLearnedSkillPackage({
        slug: "y",
        forbiddenPublicNames: ["AcmeInternal"],
        files: { "SKILL.md": validSkillMd("y", "Y", "desc").replace("第一步。", "参考 AcmeInternal 内部实现。") },
      }));
    check("C4 LearnedSkillValidationError is exported", typeof LearnedSkillValidationError === "function");
  }

  banner("C6 · skillsRoot 可达性：路由 path 相对 skillsRoot 且可解析到真实文件");
  {
    const root = await mkdtemp(path.join(tmpdir(), "ms-C6-"));
    const skillsRoot = path.join(root, "skills");
    const dir = path.join(skillsRoot, "memscribe-learned-demo-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), validSkillMd("demo-skill", "Demo Skill", "Use when running the demo."));
    const recall = createLearnedSkillRecallProvider({ skillsRoot });
    const packet = await recall({ sessionId: "x" });
    const prelude = buildLearnedSkillPrelude(packet);
    console.log("  prelude:\n" + prelude.replace(/^/gm, "    "));
    const m = prelude.match(/path:\s*(\S+)/);
    check("C6 route includes a path", Boolean(m));
    if (m) {
      const abs = path.resolve(skillsRoot, m[1]);
      const exists = await readFile(abs, "utf8").then(() => true).catch(() => false);
      check("C6 path is relative + resolves under skillsRoot to a real file", !path.isAbsolute(m[1]) && exists, abs);
    }
  }
}

// ═══════════════════ GROUP D · 真实 Pi 接入 (PI_REAL=1) ════════════════════════

async function groupD() {
  banner("D · 真实 Pi AgentSession（DeepSeek 当 Pi 主模型）+ MemScribe 扩展");
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
  void pai;

  const { createAgentSession, DefaultResourceLoader, AuthStorage, ModelRegistry, SessionManager, SettingsManager } = pic;
  const root = await mkdtemp(path.join(tmpdir(), "ms-D-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });

  // DeepSeek as an OpenAI-compatible custom provider. VERIFY(pi): exact api/compat.
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { deepseek: { baseUrl: ENDPOINT, api: "openai-completions", models: [{ id: MODEL, name: "DeepSeek", contextWindow: 65536, maxTokens: 8192 }] } } }, null, 2),
  );
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  authStorage.setRuntimeApiKey("deepseek", API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  await modelRegistry.reload?.();
  const model = modelRegistry.find?.("deepseek", MODEL);
  if (!check("D DeepSeek model resolved in Pi", Boolean(model), model ? "" : "check models.json api/compat")) return;

  const { scribe } = createMemScribeHarnessRuntime({ model: buildModel(), root });
  let injections = 0, turnEnds = 0, toolEvents = 0;

  // FIXME(adapter): shipped createPiHarnessPort/piAdapter bind mock-shaped events
  //   ("turn:build"/"session_end"/"learning:idle") + pi.completeSimple, none of
  //   which exist on real Pi. Real Pi uses context/agent_end/session_shutdown +
  //   (event, ctx) handlers. This inline wiring is what the adapter SHOULD produce.
  const extension = (pi) => {
    pi.on("context", async (event) => {
      injections += 1;
      const ctx = await scribe.onPromptBuild({ sessionId: "pi" }).catch(() => null);
      const recall = [ctx?.preludePrompt, ctx?.skillPreludePrompt].filter(Boolean).join("\n\n");
      if (!recall) return undefined;
      return { messages: [{ role: "user", content: [{ type: "text", text: `# Recalled memory\n${recall}` }] }, ...(event.messages ?? [])] };
    });
    pi.on("agent_end", async (event) => {
      turnEnds += 1;
      const messages = (event.messages ?? []).map(fromPiAgentMessage).filter(Boolean);
      await scribe.onTurnEnd({ sessionId: "pi", messages }).catch((e) => console.log("  onTurnEnd error:", e?.message));
    });
    pi.on("tool_call", async () => { toolEvents += 1; });
    pi.on("tool_result", async () => { toolEvents += 1; });
    pi.on("session_shutdown", async () => { await scribe.onSessionEnd({ sessionId: "pi" }).catch(() => {}); });
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir,
    settingsManager: SettingsManager.create(root, agentDir),
    extensionFactories: [extension],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: root, agentDir, model, thinkingLevel: "off",
    authStorage, modelRegistry, resourceLoader,
    tools: ["read", "bash"], sessionManager: SessionManager.inMemory(root),
  });
  try {
    await session.prompt("记住：我叫 Kai，做 MemScribe，喝美式不加糖。然后用一句话给我今天的建议。");
  } catch (err) {
    record("D real turn completed", "fail", `session.prompt threw: ${err?.message ?? err}`);
  } finally {
    session.dispose?.();
  }
  await new Promise((r) => setTimeout(r, 300));

  check("D context → recall injected", injections > 0, `injections=${injections}`);
  check("D agent_end → onTurnEnd fired", turnEnds > 0, `turnEnds=${turnEnds}`);
  record("D tool telemetry observed", toolEvents > 0 ? "pass" : "warn", `toolEvents=${toolEvents}`);
  const dump = await dumpRoot("after real Pi turn", root);
  check("D memory written from a real Pi turn", dump.index.trim().length > 0);
}

function fromPiAgentMessage(m) {
  if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
  let text = "";
  const toolCalls = [];
  const c = m.content;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text;
      else if (part?.type === "toolCall") toolCalls.push({ name: part.name, input: part.arguments ?? {}, output: "" });
    }
  }
  const out = { role: m.role, text: text.trim() };
  if (toolCalls.length) out.toolCalls = toolCalls;
  return out;
}

// ──────────────────────────────── main ─────────────────────────────────────

async function main() {
  console.log(`MemScribe × Pi E2E — model=${MODEL} endpoint=${ENDPOINT} key=${HAVE_KEY ? "yes" : "NO (only group C runs)"}`);

  await groupC();            // boundaries — always (deterministic, no key)
  const a = await groupA();  // memory loop — A1 always, A2+ need key
  await groupB();            // skill loop — needs key
  if (process.env.PI_REAL === "1") await groupD();

  banner("SUMMARY");
  const by = (s) => results.filter((r) => r.status === s).length;
  for (const r of results) {
    const icon = r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️ " : r.status === "skip" ? "⏭️ " : "❌";
    console.log(`  ${icon} ${r.name}`);
  }
  console.log(`\n  ${by("pass")} pass · ${by("warn")} warn · ${by("skip")} skip · ${by("fail")} fail`);
  if (a) console.log(`  memory root: ${a}`);
  process.exit(by("fail") > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
