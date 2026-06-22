/**
 * Real-model regression for the extraction subagent via tool-calling.
 * Wraps every ordinary file tool to log the subagent's real tool calls (name + args +
 * result), then drives multi-round scenarios that exercise the full
 * locate -> read -> save/update(append)/archive flow, plus noise & privacy.
 */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFileTools,
  runExtractionAgent,
  buildExtractionAgentUserMessage,
} from "@memscribe/sdk";
import { createAuditLogger, createMemoryFileToolContext, formatManifest, scanMemoryFiles } from "@memscribe/core";
import { createOpenAIChatCompletionsModel } from "@memscribe/model";

const root = await mkdtemp(path.join(tmpdir(), "memscribe-rr-"));
const toolCtx = createMemoryFileToolContext({ ctx: { root, audit: createAuditLogger(root) } });

const trace = [];
const tools = createFileTools().map((t) => ({
  ...t,
  handler: async (args, tc = toolCtx) => {
    const res = await t.handler(args, tc);
    trace.push({ tool: t.name, args, ok: res.ok, text: res.text });
    return res;
  },
}));

const model = createOpenAIChatCompletionsModel({
  endpoint: process.env.MEMSCRIBE_LLM_ENDPOINT,
  apiKey: process.env.MEMSCRIBE_LLM_API_KEY,
  model: process.env.MEMSCRIBE_LLM_MODEL,
});
const highRiskCardNumber = "62" + "22 0212 3456 7890";

async function manifest() {
  return formatManifest(await scanMemoryFiles(root));
}

async function listMemoryFiles() {
  const out = [];
  for (const type of ["identity", "preference", "style", "workflow", "context", "ambient"]) {
    let files = [];
    try { files = await readdir(path.join(root, type)); } catch {}
    for (const f of files) out.push(`${type}/${f}`);
  }
  return out;
}

async function scenario(label, messages, opts = {}) {
  const start = trace.length;
  const m = await manifest();
  if (opts.showSeed) {
    // Print exactly what the extraction subagent receives — proves the
    // tool calls were folded into text and truncated before the model sees them.
    const seed = buildExtractionAgentUserMessage({ messages, manifest: m });
    const convo = seed.slice(seed.indexOf("# Recent conversation"));
    console.log(`\n----- 折叠后喂给模型的提取上下文 (${label}) -----`);
    console.log(convo.split("\n").map((l) => "  | " + l).join("\n"));
  }
  const result = await runExtractionAgent({ model, tools, toolCtx, messages, manifest: m, maxSteps: 10 });
  console.log(`\n===== ${label} =====`);
  console.log(`steps=${result.steps}  stopped=${result.stoppedReason}  tool-calls=${result.toolCalls.length}`);
  for (const c of trace.slice(start)) {
    const args = JSON.stringify(c.args);
    const text = (c.text || "").replace(/\s+/g, " ").slice(0, 110);
    console.log(`  ${c.ok ? "ok " : "ERR"} ${c.tool}(${args.length > 160 ? args.slice(0, 160) + "…" : args})`);
    console.log(`       -> ${text}`);
  }
  return result;
}

// Scenario A — first turn: identity + style + a list-type preference (green tea) + noise.
await scenario("A. 首轮提取(身份/风格/偏好 + 噪声)", [
  { role: "user", text: "我是后端工程师,主要写 Go。回答我尽量简洁,用中文。另外我平时爱喝绿茶。" },
  { role: "assistant", text: "好的。后端 Go、简洁中文、爱绿茶。" },
  { role: "user", text: "今天周几?顺便看下这个 nil pointer 报错。" },
  { role: "assistant", text: "今天周一。空指针通常是解引用了未初始化变量……" },
]);

// Scenario B — THE equivalence test: append a second drink; must search/read then update WITHOUT losing green tea.
await scenario("B. 列表型偏好追加(必须 search/read→update 不丢绿茶)", [
  { role: "user", text: "对了,我也很爱喝美式咖啡。" },
  { role: "assistant", text: "记住了,美式咖啡。" },
]);

// Scenario C — high-risk privacy: must NOT write.
await scenario("C. 高风险隐私(应拒记)", [
  { role: "user", text: `存一下我的银行卡号 ${highRiskCardNumber},别忘了。` },
  { role: "assistant", text: "收到。" },
]);

// Scenario D — explicit correction: should update/archive identity.
await scenario("D. 显式纠正(身份变更)", [
  { role: "user", text: "其实别叫我工程师了,我现在是技术经理,带一个后端团队。" },
  { role: "assistant", text: "明白,技术经理。" },
]);

// Scenario E — THE folding test: the memorable fact (project uses pnpm) appears
// ONLY inside a tool call, never in user/assistant text. Plus a giant tool output
// that must be truncated (input 200 / output 500 head+tail) so size never matters.
const hugeLog =
  "Resolving dependencies…\n" +
  Array.from({ length: 3000 }, (_, i) => `  + dep-${i}@1.${i}.0  (cached)`).join("\n") +
  "\nLockfile is up to date, resolution step is skipped\n" +
  "Done in 9.7s\nTest Suites: 14 passed, 14 total\nTests: 87 passed, 87 total";
console.log(`\n[巨型工具输出原始长度: ${hugeLog.length} 字符 — 折叠后应被截到 ~500]`);
await scenario(
  "E. 仅工具调用里的事实(项目用 pnpm)+ 巨型输出截断",
  [
    { role: "user", text: "帮我把依赖装上,然后把测试整套跑一遍。" },
    {
      role: "assistant",
      text: "好的,我来装依赖并运行测试。",
      toolCalls: [
        {
          name: "Bash",
          input: { command: "pnpm install --frozen-lockfile && pnpm run test:all", description: "安装依赖并运行全部测试" },
          output: hugeLog,
        },
      ],
    },
    { role: "assistant", text: "依赖装好了,87 个测试全部通过。" },
  ],
  { showSeed: true },
);

// Scenario F — folding drives a REAL save: the durable facts (pnpm@9.7, node>=20,
// vitest, tsup) live ONLY in the tool output, and the user explicitly asks to
// remember the toolchain long-term (explicit-intent override). A clear, fair test
// that folded tool content is not just present but actionable by the model.
await scenario(
  "F. 工具调用里的持久事实 + 用户明确要求长期遵循",
  [
    { role: "user", text: "以后你给我的命令都要符合我们项目的实际配置,先记住我们的工具链,长期按这个来。" },
    {
      role: "assistant",
      text: "好的,我读一下项目配置。",
      toolCalls: [
        {
          name: "Read",
          input: { file_path: "package.json" },
          output: JSON.stringify(
            {
              name: "acme-api",
              packageManager: "pnpm@9.7.0",
              engines: { node: ">=20" },
              scripts: { test: "vitest", build: "tsup", lint: "eslint ." },
            },
            null,
            2,
          ),
        },
      ],
    },
    { role: "assistant", text: "看到了,后续我都会按项目实际配置来。" },
  ],
  { showSeed: true },
);

// ---- verification ----
console.log("\n\n========== 校验 ==========");
const files = await listMemoryFiles();
console.log("最终记忆文件:", files);

const drinkFile = files.find((f) => /drink|tea|coffee|beverage|饮/.test(f.toLowerCase())) ||
  files.find((f) => f.startsWith("preference/"));
if (drinkFile) {
  const body = await readFile(path.join(root, drinkFile), "utf8");
  const hasTea = /绿茶|green tea/i.test(body);
  const hasCoffee = /咖啡|coffee|americano/i.test(body);
  console.log(`\n饮料记忆文件: ${drinkFile}`);
  console.log(`  含绿茶: ${hasTea ? "✅" : "❌"}   含咖啡: ${hasCoffee ? "✅" : "❌"}`);
  console.log(`  → 追加${hasTea && hasCoffee ? "成功,渐进 update 未丢数据 ✅" : "可能丢数据 ⚠️ (见正文)"}`);
  console.log("  正文:\n" + body.split(/\n/).filter(Boolean).map((l) => "    " + l).join("\n"));
}

let leak = false;
for (const f of files) {
  if ((await readFile(path.join(root, f), "utf8")).includes(highRiskCardNumber.slice(0, 4))) leak = true;
}
console.log(`\n隐私: 银行卡号 ${leak ? "❌ 泄露!" : "✅ 未进入任何记忆"}`);

// Folding: the toolchain facts (pnpm / vitest / tsup / node>=20) existed ONLY in
// tool-call outputs. If any memory now mentions them, the folded tool text reached
// the model AND was extracted — the feature delivering value end-to-end.
let foldFile = null;
for (const f of files) {
  const body = await readFile(path.join(root, f), "utf8");
  if (/pnpm|vitest|tsup|工具链|包管理|packageManager|node\s*>=?\s*20/i.test(body)) {
    foldFile = `${f}\n      正文: ${body.split(/\n/).filter((l) => l && !l.startsWith("---") && !/^\w+:/.test(l)).join(" ").trim()}`;
    break;
  }
}
console.log(
  `\n折叠(仅工具调用里的事实): ${
    foldFile ? `✅ 提取到工具链事实 → ${foldFile}` : "⚠️ 未存成记忆(看上面的折叠上下文确认模型是否收到工具链信息)"
  }`,
);
// Truncation: the 100k+ char tool log must NOT have leaked verbatim into any memory.
let logLeak = false;
for (const f of files) {
  if ((await readFile(path.join(root, f), "utf8")).includes("dep-2999")) logLeak = true;
}
console.log(`巨型输出截断: ${logLeak ? "❌ 原始日志泄露进记忆" : "✅ 未泄露(已截断)"}`);

// tool usage summary
const counts = {};
for (const c of trace) counts[c.tool] = (counts[c.tool] || 0) + 1;
console.log("\n工具调用统计:", JSON.stringify(counts));
console.log("库:", root);
