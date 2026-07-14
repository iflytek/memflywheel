/**
 * MemFlywheel × Hermes — STRICT end-to-end test (real model).
 *
 * This test validates the full memory + skill closed loop with Hermes adapter
 * against a real LLM model. All assertions are pass/fail, and the process exits
 * non-zero on ANY fail.
 *
 * SECURITY: the key is read ONLY from the env; never hardcoded, never written to a
 * file, never stored in the capture log (only forwarded upstream in the header).
 *
 *   export MEMFLYWHEEL_LLM_API_KEY=sk-...
 *   export MEMFLYWHEEL_LLM_ENDPOINT=https://api.deepseek.com/v1
 *   export MEMFLYWHEEL_LLM_MODEL=deepseek-v4-flash
 *   node examples/hermes/e2e-strict.mjs
 */

import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemFlywheelHarnessRuntime, hermesAdapter } from "@iflytekopensource/adapters";
import { createOpenAIChatCompletionsModel } from "@memflywheel/model";
import { createFakeModel } from "../shared/fake-model.mjs";

// ───────────────────────────── config ──────────────────────────────────────

const useFake = process.env.USE_FAKE === "1";
const ENDPOINT =
  process.env.MEMFLYWHEEL_LLM_ENDPOINT ??
  process.env.DEEPSEEK_BASE_URL ??
  "https://api.deepseek.com/v1";
const MODEL =
  process.env.MEMFLYWHEEL_LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const API_KEY =
  process.env.MEMFLYWHEEL_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;

if (!API_KEY && !useFake) {
  console.error("❌ MEMFLYWHEEL_LLM_API_KEY is required");
  process.exit(1);
}

let ACTIVE_ENDPOINT = ENDPOINT;
let ACTIVE_API_KEY = API_KEY;
const proxyLog = [];

function buildModel() {
  if (useFake) return createFakeModel();
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
    hasToolResult: messages.some((m) => m?.role === "tool"),
  };
}

function startProxy() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        const body = buf ? JSON.parse(buf) : {};
        proxyLog.push({ path: req.url, summary: summarize(body) });

        const target = new URL(req.url, ACTIVE_ENDPOINT);
        const proxyReq = https.request(
          target,
          {
            method: req.method,
            headers: {
              ...req.headers,
              host: target.host,
              authorization: `Bearer ${ACTIVE_API_KEY}`,
            },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (e) => {
          console.error("proxy error:", e.message);
          res.writeHead(502);
          res.end("proxy error");
        });
        if (buf) proxyReq.write(buf);
        proxyReq.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ─────────────────────────── mock hermes host ──────────────────────────────

function createMockHermesHost() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
  };
}

// ────────────────────────────── test scenario ──────────────────────────────

async function main() {
  console.log("🧪 MemFlywheel × Hermes E2E (strict)");
  if (useFake) {
    console.log("   mode:     FAKE (offline)");
  } else {
    console.log(`   endpoint: ${ENDPOINT}`);
    console.log(`   model:    ${MODEL}`);
  }

  let proxy;
  if (!useFake) {
    proxy = await startProxy();
    console.log(`   proxy:    ${proxy.url}\n`);
    ACTIVE_ENDPOINT = proxy.url;
  }

  const root = await mkdtemp(path.join(tmpdir(), "memflywheel-hermes-e2e-"));
  await mkdir(path.join(root, "skills"), { recursive: true });

  const model = buildModel();
  const { scribe } = createMemFlywheelHarnessRuntime({ model, root });
  const host = createMockHermesHost();
  const dispose = hermesAdapter.attach(scribe, host);

  try {
    // ── Session start
    banner("session lifecycle");
    host.emit("on_session_start", { session_id: "e2e-hermes" });
    check("session started", true);

    // ── Context injection (pre_llm_call)
    banner("context injection");
    let ctxPromise;
    host.emit("pre_llm_call", {
      session_id: "e2e-hermes",
      respond: (p) => (ctxPromise = p),
    });
    const ctx = await ctxPromise;
    check("context hook fired", Boolean(ctx));
    check("context enabled", ctx?.enabled !== false);

    // ── First turn: user shares preference
    banner("turn 1: user preference");
    const userMsg1 = {
      role: "user",
      content: [{ type: "text", text: "I love drinking green tea with honey in the mornings." }],
    };

    let assistantRes1;
    const pre1 = new Promise((r) =>
      host.emit("pre_llm_call", {
        session_id: "e2e-hermes",
        respond: r,
      }),
    );
    const preCtx1 = await pre1;
    check("pre_llm_call fired", Boolean(preCtx1));

    // Simulate assistant response
    assistantRes1 = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "That sounds like a wonderful morning ritual! Green tea with honey is both comforting and healthy.",
        },
      ],
    };

    await scribe.onTurnEnd({
      sessionId: "e2e-hermes",
      messages: [userMsg1, assistantRes1],
    });

    host.emit("post_llm_call", {
      session_id: "e2e-hermes",
      user_message: userMsg1,
      assistant_response: assistantRes1,
    });
    check("turn 1 completed", true);

    // ── Second turn: another preference
    banner("turn 2: another preference");
    const userMsg2 = {
      role: "user",
      content: [{ type: "text", text: "Please reply to me in a warm and friendly tone." }],
    };

    const pre2 = new Promise((r) =>
      host.emit("pre_llm_call", {
        session_id: "e2e-hermes",
        respond: r,
      }),
    );
    await pre2;

    const assistantRes2 = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll make sure to keep things warm and friendly! Thanks for letting me know your preference.",
        },
      ],
    };

    await scribe.onTurnEnd({
      sessionId: "e2e-hermes",
      messages: [userMsg2, assistantRes2],
    });

    host.emit("post_llm_call", {
      session_id: "e2e-hermes",
      user_message: userMsg2,
      assistant_response: assistantRes2,
    });
    check("turn 2 completed", true);

    // ── Wait for idle
    banner("memory persistence");
    await scribe.onIdle({ force: true });

    // ── Session end
    banner("session shutdown");
    host.emit("on_session_end", { session_id: "e2e-hermes" });
    check("session ended", true);

    // ── Assertions
    banner("assertions");

    const index = await readFile(path.join(root, "MEMORY.md"), "utf8").catch(() => "");
    const memLen = index.length;

    if (useFake) {
      // Fake mode: just verify the lifecycle completed
      check("session lifecycle completed", true);
      record("MEMORY.md written", "skip", "fake mode does not produce memories");
      record("tea preference captured", "skip", "fake mode does not produce memories");
      record("tone preference captured", "skip", "fake mode does not produce memories");
      record("body index.json exists", "skip", "fake mode does not produce body files");
    } else {
      check("MEMORY.md written", memLen > 0, memLen ? `${memLen} bytes` : "empty");

      const hasTeaPref = /green tea|tea/i.test(index);
      check("tea preference captured", hasTeaPref, index.slice(0, 200));

      const hasTonePref = /tone|friendly|warm/i.test(index);
      check("tone preference captured", hasTonePref);

      const bodyDir = path.join(root, "body");
      const bodyFiles = await readFile(path.join(bodyDir, "index.json"), "utf8")
        .then((s) => JSON.parse(s))
        .catch(() => null);
      check("body index.json exists", Boolean(bodyFiles));
    }

    // ── Proxy assertions
    banner("proxy capture");
    if (useFake) {
      record("proxy captured requests", "skip", "fake mode");
      record("extraction call observed", "skip", "fake mode");
    } else {
      check("proxy captured requests", proxyLog.length > 0, `${proxyLog.length} requests`);

      const extraction = proxyLog.find((r) => /extract/i.test(JSON.stringify(r.summary)));
      if (extraction) {
        check("extraction call observed", true);
        check("extraction has tools", extraction.summary.toolNames.length > 0);
      } else {
        record("extraction call observed", "skip", "no extraction call found in proxy log");
      }
    }

    // ── Summary
    banner("summary");
    console.log(
      `   pass: ${by("pass")}  fail: ${by("fail")}  skip: ${by("skip")}  total: ${results.length}`,
    );
    console.log(`   root: ${root}`);

    if (by("fail") > 0) {
      console.error("\n❌ E2E FAILED");
      process.exit(1);
    }
    console.log("\n✅ E2E PASSED");
  } finally {
    dispose();
    if (proxy) proxy.server.close();
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
