/**
 * Standalone memflywheel extraction script for OpenClaw K8s E2E test.
 *
 * OpenClaw's plugin API does not expose a direct model-call interface,
 * so extraction cannot run natively inside the gateway. This script
 * provides a standalone extraction step that:
 *   1. Takes conversation prompts from CLI args
 *   2. Sends each to mock-llm with file tools (the extraction agent flow)
 *   3. Executes tool calls (glob, write) to create memory files
 *   4. Builds MEMORY.md index from extracted files
 *
 * Usage: node /e2e/openclaw/extract.mjs <workspace-dir> [prompt1] [prompt2] ...
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const MOCK_LLM_URL = "http://mock-llm.default.svc.cluster.local:8080/v1/chat/completions";

const FILE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string" }, content: { type: "string" } },
        required: ["filePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a bash command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a pattern",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
];

async function chat(messages) {
  const body = {
    model: "mock-llm",
    stream: false,
    messages,
    tools: FILE_TOOLS,
  };
  const res = await fetch(MOCK_LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer mock-key" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function executeTool(call, workspaceDir) {
  const args = JSON.parse(call.function.arguments);
  switch (call.function.name) {
    case "glob": {
      const results = [];
      async function findFiles(dir) {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              await findFiles(full);
            } else if (entry.name.endsWith(".md")) {
              results.push(full.replace(workspaceDir + "/", ""));
            }
          }
        } catch {
          /* ignore */
        }
      }
      await findFiles(workspaceDir);
      return results.length > 0 ? results.join("\n") : "(no .md files found)";
    }
    case "write": {
      const filePath = join(workspaceDir, args.filePath);
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true }).catch(() => {});
      await writeFile(filePath, args.content);
      return `Written ${args.filePath} (${args.content.length} bytes)`;
    }
    case "read": {
      try {
        return await readFile(join(workspaceDir, args.filePath), "utf8");
      } catch {
        return "File not found";
      }
    }
    default:
      return `Tool ${call.function.name} not implemented in test mock`;
  }
}

async function runExtraction(conversationMessages, workspaceDir) {
  const conversationText = conversationMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a memory extraction agent. Review the conversation and extract any user preferences, facts, or important information into memory files using the available tools.",
    },
    {
      role: "user",
      content: `# Existing memories (manifest)\nNo existing memories.\n\n# Recent conversation\n\n${conversationText}`,
    },
  ];

  // Run the tool loop (max 5 iterations)
  for (let i = 0; i < 5; i++) {
    const response = await chat(messages);
    const choice = response.choices?.[0];
    if (!choice) {
      console.log(`  iter ${i}: no choice`);
      break;
    }
    console.log(
      `  iter ${i}: finish_reason=${choice.finish_reason} tool_calls=${choice.message?.tool_calls?.length ?? 0}`,
    );

    if (choice.finish_reason === "tool_calls" && choice.message?.tool_calls?.length > 0) {
      messages.push({ role: "assistant", content: null, tool_calls: choice.message.tool_calls });

      for (const call of choice.message.tool_calls) {
        console.log(`    executing ${call.function.name}(${call.function.arguments.slice(0, 80)})`);
        const result = await executeTool(call, workspaceDir);
        console.log(`    result: ${result.slice(0, 100)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    } else {
      break;
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

const workspaceDir = process.argv[2] ?? "/home/node/.openclaw/workspace";

const prompts = process.argv.slice(3);
if (prompts.length === 0) {
  prompts.push(
    "I love drinking green tea with honey in the mornings.",
    "Please reply to me in a warm and friendly tone.",
  );
}

for (const prompt of prompts) {
  const conversationMessages = [
    { role: "user", content: prompt },
    { role: "assistant", content: "Sure, I'll remember that." },
  ];
  console.log(`Extracting: "${prompt.slice(0, 50)}..."`);
  await runExtraction(conversationMessages, workspaceDir);
}

// Build MEMORY.md index from extracted files
async function buildMemoryIndex(workspaceDir) {
  const files = [];
  async function findFiles(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          await findFiles(full);
        } else if (entry.name.endsWith(".md") && entry.name !== "MEMORY.md") {
          const relPath = full.replace(workspaceDir + "/", "");
          const content = await readFile(full, "utf8");
          files.push({ path: relPath, content });
        }
      }
    } catch {
      /* ignore */
    }
  }
  await findFiles(workspaceDir);

  if (files.length === 0) return;

  const lines = ["# Memory Index", ""];
  for (const f of files) {
    const nameMatch = f.content.match(/name:\s*(.+)/);
    const descMatch = f.content.match(/description:\s*(.+)/);
    const name = nameMatch?.[1]?.trim() ?? f.path;
    const desc = descMatch?.[1]?.trim() ?? "";
    lines.push(`- [${name}](${f.path}) — ${desc}`);
    const body = f.content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
    if (body) {
      for (const line of body.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
    lines.push("");
  }

  await writeFile(join(workspaceDir, "MEMORY.md"), lines.join("\n"));
  console.log(`MEMORY.md created with ${files.length} entries`);
}

await buildMemoryIndex(workspaceDir);
console.log("Extraction complete");
