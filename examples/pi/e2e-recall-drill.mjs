/**
 * MemFlywheel × Pi — realistic recall E2E: hybrid-retrieval accuracy + latency +
 * 3rd-layer (raw-trace) drilling. Drives the REAL Pi lifecycle:
 *   - recall  via the Pi `context` event  → onPromptBuild (hybrid: bge-m3+BM25+RRF)
 *   - extract via scribe.onTurnEnd (the same method the Pi `agent_end` hook calls,
 *     awaited here so the test is deterministic; the hook fires it detached)
 * LLM = DeepSeek, Embedding = Cloudflare bge-m3. Both behind a capture proxy.
 *
 *   DEEPSEEK_KEY=sk-... CF_KEY=cfut-... CF_ACCT=<id> node examples/pi/e2e-recall-drill.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createPiHarnessPort,
  createMemFlywheelHarnessRuntime,
} from "@memflywheel/adapters";
import { createOpenAIChatCompletionsModel, createOpenAIEmbeddingsModel } from "@memflywheel/model";
import { createFileTools } from "@memflywheel/core";

const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
const CF_KEY = process.env.CF_KEY;
const CF_ACCT = process.env.CF_ACCT;
const DS_MODEL = "deepseek-v4-flash";
const EMB_MODEL = "@cf/baai/bge-m3";

// ── capture proxy (one per upstream) ───────────────────────────────────────
const capture = []; // { tag, url, ms, request, response }
function startProxy(tag, upstream, auth) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      const t0 = Date.now();
      try {
        const up = await fetch(upstream + req.url, {
          method: req.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
          body: req.method === "GET" ? undefined : raw,
        });
        const body = await up.text();
        capture.push({ tag, url: req.url, ms: Date.now() - t0, status: up.status,
          request: safe(raw), response: safe(body) });
        res.writeHead(up.status, { "content-type": "application/json" }); res.end(body);
      } catch (e) {
        capture.push({ tag, url: req.url, error: String(e) });
        res.writeHead(502); res.end(JSON.stringify({ error: String(e) }));
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}
const safe = (s) => { try { return JSON.parse(s); } catch { return s; } };

const llmProxy = await startProxy("LLM", "https://api.deepseek.com", DEEPSEEK_KEY);
const embProxy = await startProxy("EMB", "https://api.cloudflare.com", CF_KEY);
const LLM_BASE = `http://127.0.0.1:${llmProxy.port}/v1`;
const EMB_BASE = `http://127.0.0.1:${embProxy.port}/client/v4/accounts/${CF_ACCT}/ai/v1`;

// ── real Pi host (event emitter) ───────────────────────────────────────────
function createMockPiHost() {
  const listeners = new Map();
  return {
    on(event, fn) { const s = listeners.get(event) ?? new Set(); s.add(fn); listeners.set(event, s); return () => s.delete(fn); },
    async emit(event, payload, ctx) { const out = []; for (const fn of listeners.get(event) ?? []) out.push(await fn(payload, ctx)); return out; },
  };
}

const root = await mkdtemp(path.join(tmpdir(), "memflywheel-pi-recall-"));
const model = createOpenAIChatCompletionsModel({ endpoint: LLM_BASE, apiKey: "proxy", model: DS_MODEL, maxTokens: 2048, temperature: 0 });
const embedding = createOpenAIEmbeddingsModel({ endpoint: EMB_BASE, apiKey: "proxy", model: EMB_MODEL });

const host = createMockPiHost();
const port = createPiHarnessPort(host, { model });
const { scribe, dispose } = createMemFlywheelHarnessRuntime({
  port, root,
  memoryIndexRetrieval: { mode: "auto", embeddingProvider: embedding, model: EMB_MODEL, limit: 3, minRecords: 1 },
});

const sep = (t) => console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72));
const piMsgs = (ms) => ms.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] }));

await host.emit("session_start", { sessionId: "pi" });

// ── PHASE 1: extraction (awaited scribe.onTurnEnd = the agent_end path) ──────
const turns = [
  [{ role: "user", text: "Hi, I'm Lin Wei — backend engineer at iFlytek, lead on the MemFlywheel project.", timestamp: "2026-06-23T09:00:00Z" }, { role: "assistant", text: "Hi Lin Wei." }],
  [{ role: "user", text: "Working preferences: always reply to me in Chinese, and keep answers short and to the point.", timestamp: "2026-06-23T09:02:00Z" }, { role: "assistant", text: "好的。" }],
  [{ role: "user", text: "Team repo rule: every change goes through a pull request reviewed by a committer; never push directly to main.", timestamp: "2026-06-23T09:04:00Z" }, { role: "assistant", text: "Understood." }],
  [{ role: "user", text: "My editor is Neovim, and I always use 2-space indentation.", timestamp: "2026-06-23T09:06:00Z" }, { role: "assistant", text: "Got it." }],
  [{ role: "user", text: "Our backend is written in Go and we deploy on Kubernetes.", timestamp: "2026-06-23T09:08:00Z" }, { role: "assistant", text: "Noted." }],
  [{ role: "user", text: "I'm based in Hefei, timezone UTC+8. And I'm vegetarian, so keep that in mind for any food suggestions.", timestamp: "2026-06-23T09:12:00Z" }, { role: "assistant", text: "Noted." }],
  [{ role: "user", text: "Lock down our production Postgres config on record: host db-prod-3.internal, port 5432, max connection pool 40, statement_timeout 30s, pinned to PostgreSQL 15.4.", timestamp: "2026-06-23T09:14:00Z" }, { role: "assistant", text: "Recorded." }],
];
sep("PHASE 1 — EXTRACTION (real Pi onTurnEnd path)");
const tEx = Date.now();
for (let i = 0; i < turns.length; i++) {
  const r = await scribe.onTurnEnd({ sessionId: "pi", messages: turns[i] });
  console.log(`turn ${i + 1}: ${JSON.stringify(r?.result ?? r)}`);
}
console.log(`extraction wall: ${((Date.now() - tEx) / 1000).toFixed(1)}s`);

const memFiles = [];
for (const t of ["identity", "preference", "style", "workflow", "context", "ambient"]) {
  const dir = path.join(root, t); if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) memFiles.push(`${t}/${f}`);
}
sep(`CORPUS (${memFiles.length} memories)`);
console.log(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8"));

// ── recall through the REAL Pi `context` event ──────────────────────────────
async function piRecall(query) {
  const before = capture.filter((c) => c.tag === "EMB").length;
  const t0 = Date.now();
  const results = await host.emit("context", { sessionId: "pi", query, messages: [] });
  const wall = Date.now() - t0;
  const injected = results.at(-1); // { messages: [...] } from piContextResultFromPromptBuild
  const msgs = injected?.messages ?? (Array.isArray(injected) ? injected : []);
  const plain = msgs.map((m) => {
    const c = m?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("");
    return "";
  }).join("\n\n");
  const embCalls = capture.filter((c) => c.tag === "EMB").slice(before);
  const embMs = embCalls.reduce((a, c) => a + (c.ms || 0), 0);
  const paths = [...plain.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
  const hybrid = /混合检索/.test(plain);
  return { paths, plain, wall, embMs, local: wall - embMs, hybrid };
}

// ── PHASE 2: accuracy + latency ─────────────────────────────────────────────
const labeled = [
  { q: "用户平时用什么代码编辑器？", expect: "neovim|editor|indent" },
  { q: "生产环境的数据库用的是什么？", expect: "postgres|database|db" },
  { q: "代码提交合并要遵守什么流程？", expect: "pull|pr|workflow|merge|review|repo" },
  { q: "后端是用什么编程语言写的？", expect: "go|backend|stack|kubernetes" },
  { q: "用户在哪个城市、什么时区？", expect: "hefei|timezone|utc|location" },
  { q: "给用户推荐餐厅要注意什么饮食？", expect: "vegetarian|diet|food" },
  { q: "用户叫什么名字、在哪家公司？", expect: "lin-wei|identity" },
  { q: "回复用户应该用哪种语言？", expect: "language|chinese|reply" },
  { q: "db-prod-3.internal 这台机器是做什么用的？", expect: "postgres|database|db" }, // BM25 stress
];
sep("PHASE 2 — RETRIEVAL ACCURACY + LATENCY (via Pi context event)");
let h1 = 0, h3 = 0, mrr = 0; const lat = [];
for (const { q, expect } of labeled) {
  const re = new RegExp(expect, "i");
  const r = await piRecall(q);
  lat.push(r);
  const rank = r.paths.findIndex((p) => re.test(p)) + 1;
  if (rank === 1) h1++; if (rank >= 1 && rank <= 3) h3++; if (rank >= 1) mrr += 1 / rank;
  console.log(`\nQ: ${q}\n   top${r.paths.length}: ${r.paths.join(" | ")}\n   /${expect}/ -> rank ${rank || "MISS"}  [hybrid=${r.hybrid} embed ${r.embMs}ms local ${r.local}ms total ${r.wall}ms]`);
}
const n = labeled.length, med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
sep("PHASE 2 SCORE");
console.log(`hit@1=${h1}/${n} (${(100 * h1 / n).toFixed(0)}%)  hit@3=${h3}/${n} (${(100 * h3 / n).toFixed(0)}%)  MRR=${(mrr / n).toFixed(3)}`);
console.log(`latency median: embed ${med(lat.map(x => x.embMs))}ms  local(BM25+RRF+cosine) ${med(lat.map(x => x.local))}ms  total ${med(lat.map(x => x.wall))}ms`);

// ── PHASE 3: 3rd-layer drill via a tool-calling agent fed the REAL Pi prelude ─
// (Pi's own agent runtime is external/not in this repo, so the loop is driven
//  here, but the system prompt is exactly what the Pi context event injected.)
const tools = createFileTools();
const toolCtx = { root, mode: "files" };
const oaiTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
async function runAgent(systemPrompt, question, maxSteps = 8) {
  const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: question }];
  const trace = [];
  for (let s = 0; s < maxSteps; s++) {
    const resp = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer proxy" },
      body: JSON.stringify({ model: DS_MODEL, messages, tools: oaiTools, tool_choice: "auto", temperature: 0 }),
    }).then((r) => r.json());
    const msg = resp.choices[0].message; messages.push(msg);
    const tcs = msg.tool_calls || [];
    if (!tcs.length) return { answer: msg.content, trace };
    for (const tc of tcs) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      const tool = tools.find((t) => t.name === tc.function.name);
      let out; try { out = await tool.handler(args, toolCtx); } catch (e) { out = { text: String(e) }; }
      trace.push({ tool: tc.function.name, path: args.filePath || args.pattern || args.path, offset: args.offset, limit: args.limit });
      messages.push({ role: "tool", tool_call_id: tc.id, content: (out.text || "").slice(0, 4000) });
    }
  }
  return { answer: "(max steps)", trace };
}

const detailQ = "我们生产 Postgres 的连接池最大是多少个连接？statement timeout 设的是多少？";
const rc = await piRecall(detailQ);
// the drill agent's system prompt = exactly what the Pi context event injected
const injectedText = rc.plain;
const hintSuffix = "\n\n如果某条记忆正文不足以回答，正文末尾的 ## Sources 指向原始对话轨迹文件（形如 .memflywheel/sources/xxx.jsonl#L13-L20）。可用 read 工具按该文件与行号区间读取原始细节。";

sep("PHASE 3A — DRILL (product as-is: only what Pi injected)");
console.log("Q:", detailQ);
const a = await runAgent(injectedText, detailQ);
console.log("tools:", JSON.stringify(a.trace));
console.log("drilled into .memflywheel/sources?", a.trace.some((t) => String(t.path || "").includes(".memflywheel/sources")));
console.log("ANSWER:", a.answer);

sep("PHASE 3B — DRILL (with explicit sources hint)");
console.log("Q:", detailQ);
const b = await runAgent(injectedText + hintSuffix, detailQ);
console.log("tools:", JSON.stringify(b.trace));
console.log("drilled into .memflywheel/sources?", b.trace.some((t) => String(t.path || "").includes(".memflywheel/sources")));
console.log("ANSWER:", b.answer);

sep("GROUND TRUTH — postgres memory body");
const pg = memFiles.find((f) => /postgres|database|db|prod/i.test(f));
if (pg) console.log(`--- ${pg} ---\n` + fs.readFileSync(path.join(root, pg), "utf8"));

sep("CAPTURE DIGEST");
console.log(`LLM calls: ${capture.filter(c => c.tag === "LLM").length}  EMB calls: ${capture.filter(c => c.tag === "EMB").length}`);
console.log("memory root:", root);

dispose(); llmProxy.close(); embProxy.close();
sep("DONE");
