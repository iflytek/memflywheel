# OpenClaw integration

The plugin occupies OpenClaw's memory slot and resolves the active agent model through `prepareSimpleCompletionModelForAgent`. Its `completeWithPreparedSimpleCompletionModel` transport is wrapped as a pi-ai stream; Extraction, Dream, and Skill Evolution all run in the shared Pi Agent Core runner.

No separate write-side model key or endpoint is configured.
