/**
 * A deterministic, offline tool-calling completion for the examples' smoke tests.
 *
 * It plays the part of the extraction subagent without any network or API key:
 * the loop drives it round by round, and on each round it returns the next
 * scripted assistant turn. Use this when USE_FAKE=1.
 *
 * The script demonstrates a realistic multi-step subagent:
 *   1. Round 1 — call `memory_list` to inspect existing memories (add vs update).
 *   2. Round 2 — call `memory_save` twice in one turn: a clean preference and a
 *      style note.
 *   3. Round 3 — stop. The subagent deliberately does NOT persist the high-risk
 *      secret it saw in the conversation (privacy via the prompt: a real model
 *      is instructed to refuse; the fake mirrors that by simply never writing it).
 *
 * Each round-trip is one call to the returned `ToolCompletion`. The loop feeds
 * the tool results back as role:"tool" messages between calls; the fake ignores
 * them and advances purely by call count, which is enough for a deterministic
 * smoke test.
 */

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Build a fresh fake `ToolCompletion`. State (the round counter) is per-instance,
 * so each example/run gets an independent subagent.
 */
export function createFakeToolCompletion() {
  let round = 0;
  return async (_req) => {
    round += 1;

    // Round 1: inspect existing memories first.
    if (round === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("c-list", "memory_list", {})],
        },
        finishReason: "tool_calls",
      };
    }

    // Round 2: write two high-value memories in a single turn. The high-risk
    // secret from the conversation is intentionally omitted (declined).
    if (round === 2) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            toolCall("c-save-1", "memory_save", {
              type: "preference",
              name: "Preferred drink",
              description: "User's go-to beverage",
              body: "The user prefers green tea over coffee.",
            }),
            toolCall("c-save-2", "memory_save", {
              type: "style",
              name: "Reply tone",
              description: "How the user likes replies",
              body: "The user appreciates short, direct acknowledgements.",
            }),
          ],
        },
        finishReason: "tool_calls",
      };
    }

    // Round 3+: nothing more worth remembering — call no tools and decline.
    return {
      message: {
        role: "assistant",
        content: "No further memories worth saving this round.",
      },
      finishReason: "stop",
    };
  };
}
