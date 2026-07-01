import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveOpenAICompatibleEnvModelConfig } from "./openai-env-model.js";

test("resolveOpenAICompatibleEnvModelConfig accepts proxy-style env aliases", () => {
  const config = resolveOpenAICompatibleEnvModelConfig({
    env: {
      CUSTOM_BASE_URL: " http://127.0.0.1:4891/v1/chat/completions ",
      CUSTOM_API_KEY: " proxy-key ",
      CUSTOM_MODEL: " deepseek-v4-flash ",
    },
  });

  assert.equal(config.endpoint, "http://127.0.0.1:4891/v1");
  assert.equal(config.apiKey, "proxy-key");
  assert.equal(config.model, "deepseek-v4-flash");
});

test("resolveOpenAICompatibleEnvModelConfig keeps MemFlywheel env precedence", () => {
  const config = resolveOpenAICompatibleEnvModelConfig({
    env: {
      MEMFLYWHEEL_LLM_ENDPOINT: "https://api.deepseek.com/v1",
      MEMFLYWHEEL_LLM_API_KEY: "mem-key",
      MEMFLYWHEEL_LLM_MODEL: "deepseek-v4-pro",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-5.5",
    },
  });

  assert.equal(config.endpoint, "https://api.deepseek.com/v1");
  assert.equal(config.apiKey, "mem-key");
  assert.equal(config.model, "deepseek-v4-pro");
});
