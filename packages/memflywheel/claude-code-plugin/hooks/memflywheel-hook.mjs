#!/usr/bin/env node
// Claude Code command hook entry. Reads the hook JSON from stdin and prints
// `hookSpecificOutput` for SessionStart / UserPromptSubmit. Every failure fails
// open (exit 0, message on stderr) so a broken memory store never blocks a prompt.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runHook } from "./recall.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT?.trim() ||
    path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const output = await runHook(await readStdin(), { pluginRoot });
  if (output) process.stdout.write(JSON.stringify(output));
} catch (err) {
  process.stderr.write(`memflywheel: ${err instanceof Error ? err.message : String(err)}\n`);
}
