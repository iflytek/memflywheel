/**
 * Deterministic offline canonical model for example smoke tests.
 *
 * It plays the part of the extraction subagent without network or API keys. The
 * SDK sees only @memflywheel/model's canonical shape: messages, tool definitions,
 * and structured tool call inputs.
 */

import { serializeMemoryFile } from "@memflywheel/core";

function toolCall(id, name, input) {
  return { id, name, input };
}

function writeMemoryArgs(input) {
  return {
    filePath: `${input.type}/${input.filename}`,
    content: serializeMemoryFile(input),
  };
}

export function createFakeModel() {
  let round = 0;
  return {
    async complete(_req) {
      round += 1;

      if (round === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [toolCall("c-list", "glob", { pattern: "**/*.md" })],
          },
          finishReason: "tool-calls",
        };
      }

      if (round === 2) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              toolCall(
                "c-save-1",
                "write",
                writeMemoryArgs({
                  type: "preference",
                  filename: "preferred-drink.md",
                  name: "Preferred drink",
                  description: "User's go-to beverage",
                  body: "The user prefers green tea over coffee.",
                }),
              ),
              toolCall(
                "c-save-2",
                "write",
                writeMemoryArgs({
                  type: "style",
                  filename: "reply-tone.md",
                  name: "Reply tone",
                  description: "How the user likes replies",
                  body: "The user appreciates short, direct acknowledgements.",
                }),
              ),
            ],
          },
          finishReason: "tool-calls",
        };
      }

      return {
        message: {
          role: "assistant",
          content: "No further memories worth saving this round.",
        },
        finishReason: "stop",
      };
    },
  };
}
