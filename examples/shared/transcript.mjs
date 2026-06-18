/**
 * A small sample turn the examples feed to onTurnEnd.
 *
 * The user volunteers a durable preference (worth remembering) and, separately,
 * a high-risk secret (an API key) that must NOT be persisted. The extraction
 * subagent is expected to save the preference and decline the secret.
 */
const sampleApiKey = "sk" + "-ABCDEFabcdef0123456789ABCDEFabcdef0123456789ABCD";

export const transcript = [
  {
    role: "user",
    text:
      "Just so you know, I always drink green tea, never coffee. " +
      `Also my OpenAI key is ${sampleApiKey} — keep it handy.`,
  },
  { role: "assistant", text: "Got it — I'll remember you prefer green tea." },
];
