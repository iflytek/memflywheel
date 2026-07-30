import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  Transport,
} from "@earendil-works/pi-ai";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

export interface PiAgentModelBinding {
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  transport?: Transport;
  /** Host-resolved request context forwarded unchanged on every provider turn. */
  request?: SimpleStreamOptions & Record<string, unknown>;
}

export type ResolvePiAgentModel = () => PiAgentModelBinding | Promise<PiAgentModelBinding>;

export interface MemoryAgentToolResult {
  ok: boolean;
  text: string;
  changed?: string[];
}

export interface MemoryAgentTool {
  name: string;
  description: string;
  inputSchema: object;
  execute(args: unknown, signal?: AbortSignal): Promise<MemoryAgentToolResult>;
}

export interface MemoryAgentResult {
  steps: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
  changed: string[];
  finalContent: string | null;
}

export interface RunMemoryAgentOptions {
  resolveModel: ResolvePiAgentModel;
  tools: MemoryAgentTool[];
  systemPrompt: string;
  userMessage: string;
  maxSteps?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_STEPS = 12;

function maxSteps(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("maxSteps must be a positive integer");
  }
  return resolved;
}

function assistantText(message: AssistantMessage): string | null {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || null;
}

/** Run every MemFlywheel write-side task on Pi's official Agent implementation. */
export async function runMemoryAgent(options: RunMemoryAgentOptions): Promise<MemoryAgentResult> {
  const binding = await options.resolveModel();
  const limit = maxSteps(options.maxSteps);
  const toolCalls: MemoryAgentResult["toolCalls"] = [];
  const changed = new Set<string>();
  let steps = 0;
  let reachedLimit = false;
  let finalContent: string | null = null;

  const tools: AgentTool[] = options.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, args, signal) {
      const result = await tool.execute(args, signal);
      toolCalls.push({ name: tool.name, ok: result.ok });
      for (const path of result.changed ?? []) changed.add(path);
      if (!result.ok) throw new Error(result.text);
      return {
        content: [{ type: "text", text: result.text }],
        details: { changed: result.changed ?? [] },
      };
    },
  }));

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: binding.model,
      thinkingLevel: binding.thinkingLevel ?? "off",
      tools,
      messages: [],
    },
    streamFn: (model, context, streamOptions) =>
      binding.streamFn(model, context, { ...streamOptions, ...binding.request }),
    getApiKey: binding.getApiKey,
    sessionId: binding.sessionId,
    transport: binding.transport,
    toolExecution: "sequential",
  });

  const unsubscribe = agent.subscribe((event) => {
    if (event.type !== "turn_end") return;
    steps += 1;
    if (event.message.role === "assistant") finalContent = assistantText(event.message);
    const requestedTools =
      event.message.role === "assistant" &&
      event.message.content.some((part) => part.type === "toolCall");
    if (requestedTools && steps >= limit) {
      reachedLimit = true;
      agent.abort();
    }
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    await agent.prompt(options.userMessage);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    if (binding.sessionId) cleanupSessionResources(binding.sessionId);
  }

  if (options.signal?.aborted) throw options.signal.reason ?? new Error("memory agent aborted");
  if (reachedLimit) throw new Error(`memory agent exceeded maxSteps (${limit})`);
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);

  return { steps, toolCalls, changed: [...changed], finalContent };
}
