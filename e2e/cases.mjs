/**
 * E2E test case definitions — pure data.
 *
 * Each case fully defines:
 *   (a) prompts + chatResponse  → what the agent says, what mock-llm replies
 *   (b) extraction              → what mock-llm writes to memory during extraction
 *   (c) assertions              → what to verify in MEMORY.md
 *
 * Adding a new case: append an object to CASES.
 */

export const CASES = [
  {
    name: "preference: tea + tone",

    prompts: [
      {
        text: "I love drinking green tea with honey in the mornings.",
        waitMs: 5000,
        chatResponse:
          "That sounds like a wonderful morning ritual! Green tea with honey is both comforting and healthy.",
      },
      {
        text: "Please reply to me in a warm and friendly tone.",
        waitMs: 8000,
        chatResponse:
          "I'll make sure to keep things warm and friendly! Thanks for letting me know your preference.",
      },
    ],

    extraction: [
      {
        match: "tea|drink|honey|beverage",
        filePath: "preference/drinks.md",
        frontmatter: {
          type: "preference",
          name: "Drinks",
          description: "Preferred drinks and beverages",
          terms: ["green tea", "honey", "beverage", "morning drink"],
        },
        body: "The user loves drinking green tea with honey in the mornings.",
      },
      {
        match: "tone|friendly|warm|style",
        filePath: "preference/communication-style.md",
        frontmatter: {
          type: "preference",
          name: "Communication Style",
          description: "Preferred communication tone and style",
          terms: ["warm", "friendly", "tone", "communication"],
        },
        body: "The user prefers a warm, friendly, and approachable communication tone.",
      },
    ],

    assertions: [
      { label: "tea preference captured", regex: /green tea|tea/i },
      { label: "tone preference captured", regex: /tone|friendly|warm/i },
    ],
  },
];
