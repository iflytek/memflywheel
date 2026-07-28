# Hermes integration

The published Hermes MemoryProvider keeps model routing and credentials inside Hermes. Its Python bridge converts one Pi context request into `agent.auxiliary_client.call_llm`, returns one native Pi assistant message, and leaves all tool iteration to Pi Agent Core.

`plugin-register.mjs` documents the host registration boundary; production installation uses `@iflytekopensource/memflywheel`.
