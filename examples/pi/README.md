# Pi integration

Install the published Pi package:

```bash
pi install npm:@iflytekopensource/adapters
```

The extension passes Pi's active `ctx.model`, native `streamSimple`, host auth, thinking level, and isolated background session id into the shared Pi Agent Core runner. Changing the model in Pi changes the memory agent model on the next run; no `MEMFLYWHEEL_LLM_*` variables are read.

`extension.mjs` is the readable source equivalent of the published package entrypoint.
