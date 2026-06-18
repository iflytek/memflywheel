/**
 * Real-model regression for the dream consolidation subagent via a
 * tool-calling model. Seeds a deliberately messy store, then runs a full dream pass:
 *
 *   1. the deterministic structural pre-pass (delete identical-body duplicates,
 *      relocate a misfiled memory) — LLM-free, guaranteed; then
 *   2. the consolidation subagent, which reads full bodies and merges near-
 *      duplicates / compresses over-long notes via the memory tools.
 *
 * It wraps every memory tool to log the subagent's real tool calls, then verifies
 * the deterministic outcomes strictly and the semantic work by "no data loss".
 *
 * Run (uses YOUR key; never hardcode it):
 *   MEMSCRIBE_LLM_ENDPOINT=<your OpenAI-compatible base, e.g. https://.../api/v1> \
 *   MEMSCRIBE_LLM_MODEL=<model id> \
 *   MEMSCRIBE_LLM_API_KEY=<your key> \
 *   node examples/dream-regression.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemScribe, createToolCompletion, runDreamAgent } from "@memscribe/sdk";

const root = await mkdtemp(path.join(tmpdir(), "memscribe-dream-rr-"));

async function seed(relativePath, frontmatter, body) {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(full, `---\n${fm}\n---\n\n${body}\n`, "utf8");
}

// --- a realistic, messy developer memory store that genuinely needs cleanup ---

// Stable identity (should be left alone).
await seed("identity/role.md", { name: "Role", type: "identity" }, "A backend engineer who mainly writes Go.");

// Two same-topic beverage preferences accumulated on different days — the subagent
// should MERGE these into one drinks preference, keeping BOTH items (no data loss).
await seed("preference/tea.md", { name: "Green tea", type: "preference" }, "Prefers green tea as the daily drink.");
await seed(
  "preference/coffee.md",
  { name: "Coffee", type: "preference" },
  "Also enjoys an americano in the afternoon.",
);

// Two same-topic team notes — candidates to merge into one roster, keeping both people.
await seed("ambient/mara.md", { name: "Mara", type: "ambient" }, "Mara is the backend team lead.");
await seed("ambient/jin.md", { name: "Jin", type: "ambient" }, "Jin runs the infrastructure and the on-call rotation.");

// Exact-duplicate bodies -> deterministic delete-duplicate (LLM-free).
await seed("style/brevity.md", { name: "Brevity", type: "style" }, "Keep replies short and to the point.");
await seed("style/short.md", { name: "Be concise", type: "style" }, "Keep replies short and to the point.");

// Misfiled: lives in identity/ but declares type preference -> deterministic relocate.
await seed("identity/editor.md", { name: "Editor", type: "preference" }, "Uses Neovim as the main editor.");

// An over-long workflow note holding a full numbered SOP — complete methods belong
// in a skill, so the subagent should compress this to a short trigger signal.
await seed(
  "workflow/debugging.md",
  { name: "Debugging routine", type: "workflow" },
  [
    "When a production bug comes in, the routine is: 1) reproduce it locally with the exact input;",
    "2) read the full stack trace and find the first frame in our own code; 3) add a failing test that",
    "captures the bug; 4) bisect recent commits if it is a regression; 5) check the logs and metrics",
    "dashboard for the time window; 6) verify the config and feature flags; 7) fix the root cause, not",
    "the symptom; 8) run the full suite; 9) write a short postmortem note.",
  ].join(" "),
);

const toolCompletion = createToolCompletion({
  endpoint: process.env.MEMSCRIBE_LLM_ENDPOINT,
  apiKey: process.env.MEMSCRIBE_LLM_API_KEY,
  model: process.env.MEMSCRIBE_LLM_MODEL,
});

// A dreamRunner that wraps core's tools with a tracer, then drives the real loop.
const trace = [];
const dreamRunner = async (input) => {
  const tracedTools = input.tools.map((t) => ({
    ...t,
    handler: async (args, tc) => {
      const res = await t.handler(args, tc);
      trace.push({ tool: t.name, args, ok: res.ok, text: res.text });
      return res;
    },
  }));
  return runDreamAgent({
    toolCompletion,
    tools: tracedTools,
    toolCtx: input.toolCtx,
    health: input.health,
    typeReview: input.typeReview,
    manifest: input.manifest,
    index: input.index,
    coordination: input.coordination,
    maxSteps: 18,
  });
};

const scribe = createMemScribe({ root, dreamRunner });

async function listFiles() {
  const out = [];
  for (const type of ["identity", "preference", "style", "workflow", "context", "ambient"]) {
    let files = [];
    try {
      files = await readdir(path.join(root, type));
    } catch {}
    for (const f of files) out.push(`${type}/${f}`);
  }
  return out;
}

console.log("库:", root);
console.log("整理前文件:", await listFiles());

const result = await scribe.runDream({ reason: "idle", memoryAction: "consolidate", topics: ["drinks", "team"] });
console.log(`\n===== dream pass =====`);
console.log(`ran=${result.ran}  reason=${result.reason}`);
console.log(`deterministic changed=${result.changed?.length ?? 0}  deleted=${result.deleted?.length ?? 0}`);

console.log(`\n----- subagent 真实 tool calls (${trace.length}) -----`);
for (const c of trace) {
  const args = JSON.stringify(c.args);
  const text = (c.text || "").replace(/\s+/g, " ").slice(0, 120);
  console.log(`  ${c.ok ? "ok " : "ERR"} ${c.tool}(${args.length > 180 ? args.slice(0, 180) + "…" : args})`);
  console.log(`       -> ${text}`);
}

// --- verification ---
console.log("\n\n========== 校验 ==========");
const files = await listFiles();
console.log("整理后文件:", files);

const styleCount = files.filter((f) => f.startsWith("style/")).length;
console.log(`\n[确定性] 重复 style 去重: ${styleCount === 1 ? "✅ 仅剩 1 个" : `❌ 剩 ${styleCount} 个`}`);

const relocated = !files.includes("identity/editor.md") && files.some((f) => f === "preference/editor.md");
console.log(`[确定性] 放错目录搬迁 (identity/editor→preference/editor): ${relocated ? "✅" : "❌"}`);

async function bodyOfDir(prefix) {
  let text = "";
  for (const f of files.filter((f) => f.startsWith(prefix))) {
    text += "\n" + (await readFile(path.join(root, f), "utf8"));
  }
  return text;
}

const prefText = await bodyOfDir("preference/");
const hasTea = /green tea|绿茶/i.test(prefText);
const hasCoffee = /coffee|americano|咖啡/i.test(prefText);
const prefCount = files.filter((f) => f.startsWith("preference/")).length;
console.log(
  `[语义] 饮料偏好整理: ${prefCount} 个 preference 文件; 含茶 ${hasTea ? "✅" : "❌"} 含咖啡 ${hasCoffee ? "✅" : "❌"}` +
    ` → ${hasTea && hasCoffee ? "无数据丢失 ✅" : "可能丢数据 ⚠️"}`,
);

const ambientText = await bodyOfDir("ambient/");
const hasMara = /mara/i.test(ambientText);
const hasJin = /jin/i.test(ambientText);
const ambientCount = files.filter((f) => f.startsWith("ambient/")).length;
console.log(
  `[语义] 团队记忆整理: ${ambientCount} 个 ambient 文件; 含 Mara ${hasMara ? "✅" : "❌"} 含 Jin ${hasJin ? "✅" : "❌"}` +
    ` → ${hasMara && hasJin ? "无数据丢失 ✅" : "可能丢数据 ⚠️"}`,
);

const wf = files.find((f) => f.startsWith("workflow/"));
if (wf) {
  const body = (await readFile(path.join(root, wf), "utf8")).split(/---/).slice(2).join("---").trim();
  const hasNumberedSteps = /\b[3-9]\)/.test(body);
  console.log(
    `[语义] 超长 workflow 压缩: ${wf} 正文 ${body.length} 字符; ${hasNumberedSteps ? "仍含多步编号 ⚠️" : "已压成短触发 ✅"}`,
  );
}

console.log("\n----- 最终正文 -----");
for (const f of files) {
  const raw = await readFile(path.join(root, f), "utf8");
  const body = raw.split(/---/).slice(2).join("---").trim().replace(/\s+/g, " ");
  console.log(`  ${f}: ${body.slice(0, 140)}`);
}

const counts = {};
for (const c of trace) counts[c.tool] = (counts[c.tool] || 0) + 1;
console.log("\n工具调用统计:", JSON.stringify(counts));
