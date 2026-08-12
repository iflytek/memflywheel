import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ResolvePiAgentModel } from "@memflywheel/sdk";

type RawRecord = Record<string, unknown>;

export interface OpenClawNativeModelSelection {
  readonly agentId?: string;
  readonly modelRef?: string;
}

export interface OpenClawNativeModelRuntime {
  readonly currentConfig: () => unknown;
  readonly resolveDefaultAgentId: (config: unknown) => string;
  readonly prepareForAgent: (input: {
    readonly cfg: unknown;
    readonly agentId: string;
    readonly modelRef?: string;
  }) => Promise<unknown>;
  readonly completePrepared: (input: {
    readonly model: unknown;
    readonly auth: unknown;
    readonly context: unknown;
    readonly cfg: unknown;
    readonly options: { readonly signal?: AbortSignal };
  }) => Promise<unknown>;
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object";
}

function assistantMessage(value: unknown): AssistantMessage {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) {
    throw new Error("OpenClaw native completion returned an invalid Pi assistant message.");
  }
  return value as unknown as AssistantMessage;
}

/** Bind OpenClaw's native model/auth transport to the single Pi Agent Core runner. */
export function createOpenClawHostModel(
  runtime: OpenClawNativeModelRuntime,
  selection: () => OpenClawNativeModelSelection,
): ResolvePiAgentModel {
  return async () => {
    const cfg = runtime.currentConfig();
    const selected = selection();
    const agentId = selected.agentId ?? runtime.resolveDefaultAgentId(cfg);
    if (!agentId) throw new Error("OpenClaw could not resolve the active agent id.");
    const prepared = await runtime.prepareForAgent({
      cfg,
      agentId,
      ...(selected.modelRef ? { modelRef: selected.modelRef } : {}),
    });
    if (!isRecord(prepared)) throw new Error("OpenClaw returned an invalid prepared model.");
    if (typeof prepared.error === "string") throw new Error(prepared.error);
    if (!("model" in prepared) || !("auth" in prepared)) {
      throw new Error("OpenClaw did not provide a prepared model and credential.");
    }

    return {
      model: prepared.model as Model<Api>,
      streamFn: async (_model, context, options) => {
        const message = assistantMessage(
          await runtime.completePrepared({
            model: prepared.model,
            auth: prepared.auth,
            context,
            cfg,
            options: { signal: options?.signal },
          }),
        );
        const stream = createAssistantMessageEventStream();
        if (message.stopReason === "pending") {
          throw new Error("OpenClaw native completion returned before reaching a terminal state.");
        } else if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        return stream;
      },
    };
  };
}
