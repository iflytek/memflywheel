/**
 * Mock LLM server — OpenAI-compatible HTTP endpoint for K8s e2e tests.
 *
 * Data-driven: reads case config from /tmp/case-config.json.
 * The test runner writes this file before each test case via `kubectl exec`.
 *
 * Config format:
 * {
 *   chat: [{ match: "regex", response: "..." }],
 *   extraction: [{ match: "regex", filePath: "...", frontmatter: {...}, body: "..." }]
 * }
 *
 * Behavior:
 *   - Normal chat → match user text against config.chat patterns
 *   - Extraction (tools present) → 3-stage: glob → write (from config) → done
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8080);
const CONFIG_PATH = "/tmp/case-config.json";

// ─── config loading ────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { chat: [], extraction: [] };
  }
}

// ─── response builders ─────────────────────────────────────────────────────

function chatCompletion(id, content) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-llm",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function toolCompletion(id, toolCalls) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-llm",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
  };
}

function buildWriteArgs(rule) {
  const { filePath, frontmatter, body } = rule;
  const fm = [
    "---",
    `type: ${frontmatter.type}`,
    `name: ${frontmatter.name}`,
    `description: ${frontmatter.description}`,
    `retrieval_terms:`,
    ...frontmatter.terms.map((t) => `  - ${t}`),
    `occurred_on: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
  ].join("\n");
  return JSON.stringify({ filePath, content: fm + body + "\n" });
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Extract user text from messages (skip system/tool roles). */
function getUserText(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === "tool" || msg.role === "system") continue;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c) => c.text ?? "").join(" ")
          : "";
    if (!text) continue;
    const recentMatch = text.match(/Recent conversation\n([\s\S]*?)$/i);
    if (recentMatch) {
      const userLines = recentMatch[1]
        .split("\n")
        .filter((l) => l.startsWith("User: "))
        .map((l) => l.slice(6))
        .join(" ");
      if (userLines) parts.push(userLines);
    } else {
      // Strip memory-context tags (injected by memflywheel plugin) before checking
      const cleanText = text.replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, "").trim();
      if (cleanText && !/^#\s+Existing memories/i.test(cleanText)) {
        parts.push(cleanText);
      }
    }
  }
  return parts.join(" ");
}

// ─── chat response (data-driven) ───────────────────────────────────────────

function handleChat(body) {
  const userText = getUserText(body.messages ?? []);
  const config = loadConfig();
  for (const rule of config.chat) {
    if (new RegExp(rule.match, "i").test(userText)) return rule.response;
  }
  return "Got it! I'll remember that for next time.";
}

// ─── extraction (data-driven, 3-stage) ─────────────────────────────────────

function handleExtraction(body) {
  const messages = body.messages ?? [];
  const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!(toolNames.includes("write") && toolNames.includes("glob"))) return null;

  const toolResults = messages.filter((m) => m.role === "tool");
  const userText = getUserText(messages);
  const config = loadConfig();

  // Stage 0: glob to check existing files
  if (toolResults.length === 0) {
    return {
      type: "tool_calls",
      toolCalls: [
        {
          id: "call_glob_init",
          type: "function",
          function: { name: "glob", arguments: JSON.stringify({ pattern: "**/*.md" }) },
        },
      ],
    };
  }

  // Stage 1: match against config.extraction → write file
  if (toolResults.length === 1) {
    for (const rule of config.extraction) {
      if (new RegExp(rule.match, "i").test(userText)) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call_write_1",
              type: "function",
              function: { name: "write", arguments: buildWriteArgs(rule) },
            },
          ],
        };
      }
    }
    return { type: "done", content: "Nothing worth remembering from this conversation." };
  }

  // Stage 2+: done
  return { type: "done", content: "Memory extraction complete." };
}

// ─── streaming helpers ─────────────────────────────────────────────────────

function writeSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamChatCompletion(res, id, content) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSSE(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-llm",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  writeSSE(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-llm",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamToolCompletion(res, id, toolCalls) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSSE(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-llm",
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [] }, finish_reason: null }],
  });
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    writeSSE(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "mock-llm",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  writeSSE(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-llm",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── server ────────────────────────────────────────────────────────────────

let reqCounter = 0;

const server = createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const id = `mock-${++reqCounter}`;
    const hasStream = buf.includes('"stream":true') || buf.includes('"stream": true');
    const hasTools = buf.includes('"tools"');
    console.error(`[${id}] ${req.method} ${req.url} stream=${hasStream} tools=${hasTools}`);

    // Health check
    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    // Model list
    if (req.url === "/v1/models" || req.url === "/api/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-llm", object: "model", owned_by: "mock" }],
        }),
      );
      return;
    }
    // Hermes provider detection
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "mock-llm", model: "mock-llm" }] }));
      return;
    }
    if (req.url === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0" }));
      return;
    }
    if (req.url === "/v1/props" || req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }

    // Chat completions
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const body = buf ? JSON.parse(buf) : {};

      // Extraction request (tools present)
      const extraction = handleExtraction(body);
      if (extraction) {
        if (extraction.type === "tool_calls") {
          if (hasStream) streamToolCompletion(res, id, extraction.toolCalls);
          else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(toolCompletion(id, extraction.toolCalls)));
          }
        } else {
          if (hasStream) streamChatCompletion(res, id, extraction.content);
          else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(chatCompletion(id, extraction.content)));
          }
        }
        return;
      }

      // Normal chat
      const content = handleChat(body);
      if (hasStream) streamChatCompletion(res, id, content);
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(chatCompletion(id, content)));
      }
      return;
    }

    // Fallback
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock-llm listening on :${PORT}`);
});
