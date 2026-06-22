/**
 * MemScribe MCP server: dispatch + tool / resource / prompt handlers, plus the
 * stdio transport runner.
 *
 * Tool face:
 *   - read / write / edit / bash / glob / grep : root-bound ordinary file tools
 *
 * Resources:
 *   - memscribe://index    : the derived MEMORY.md index
 *   - memscribe://manifest : one-line-per-entry manifest of current memories
 *
 * Prompt:
 *   - memscribe.with_memory : stable memory rules + current index, ready to prepend
 *
 * All memory semantics come from @memscribe/core. The server itself never calls
 * an LLM and performs no retrieval / scoring / ranking.
 */

import {
  buildMemoryInstructionPrompt,
  buildMemoryIndexPrompt,
  readMemoryIndex,
  scanMemoryFiles,
  syncMemoryIndex,
  formatManifest,
  ensureMemoryDir,
  getMemoryRoot,
  withLock,
  createAuditLogger,
  createFileTools,
  fileToolMap,
  createMemoryFileToolContext,
  type StorageContext,
  type FileTool,
  type FileToolContext,
} from "@memscribe/core";

import {
  ErrorCode,
  RpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcId,
  makeSuccess,
  makeError,
  isNotification,
} from "./protocol.js";

export const SERVER_NAME = "memscribe";
export const SERVER_VERSION = "0.1.0";
export const PROTOCOL_VERSION = "2024-11-05";

export const INDEX_RESOURCE_URI = "memscribe://index";
export const MANIFEST_RESOURCE_URI = "memscribe://manifest";
export const WITH_MEMORY_PROMPT = "memscribe.with_memory";

export interface ServerOptions {
  /** Memory root. Falls back to getMemoryRoot() (MEMSCRIBE_HOME / OS data dir). */
  root?: string;
  /** Hard secret gate for write/edit. Defaults to TRUE for the MCP face. */
  refuseSecrets?: boolean;
}

interface ToolText {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolText {
  const out: ToolText = { content: [{ type: "text", text }] };
  if (isError) out.isError = true;
  return out;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, `missing or empty string param: ${key}`);
  }
  return v;
}

/** Tool descriptors advertised via tools/list. */
const TOOL_DEFINITIONS = createFileTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })) as ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;

const RESOURCE_DEFINITIONS = [
  {
    uri: INDEX_RESOURCE_URI,
    name: "Memory index (MEMORY.md)",
    description: "The derived MEMORY.md index of all current memories.",
    mimeType: "text/markdown",
  },
  {
    uri: MANIFEST_RESOURCE_URI,
    name: "Memory manifest",
    description: "One line per memory entry: [type] path (date): description.",
    mimeType: "text/plain",
  },
] as const;

const PROMPT_DEFINITIONS = [
  {
    name: WITH_MEMORY_PROMPT,
    description:
      "Inject the user's long-term memory: stable recall rules followed by the current MEMORY.md index, " +
      "ready to prepend to a conversation.",
    arguments: [],
  },
] as const;

/**
 * The MCP server. Holds a resolved root and an audit-backed storage context.
 * Methods map 1:1 to MCP JSON-RPC methods and are individually testable.
 */
export class MemScribeMcpServer {
  readonly root: string;
  private readonly storage: StorageContext;
  private readonly toolCtx: FileToolContext;
  private readonly tools: Map<string, FileTool>;
  private initialized = false;

  constructor(options: ServerOptions = {}) {
    this.root = getMemoryRoot({ root: options.root });
    this.storage = { root: this.root, audit: createAuditLogger(this.root) };
    this.toolCtx = createMemoryFileToolContext({
      ctx: this.storage,
      refuseSecrets: options.refuseSecrets !== false,
    });
    this.tools = fileToolMap(createFileTools());
  }

  /** MCP initialize handshake. */
  handleInitialize(): unknown {
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    };
  }

  listTools(): unknown {
    return { tools: TOOL_DEFINITIONS };
  }

  listResources(): unknown {
    return { resources: RESOURCE_DEFINITIONS };
  }

  listPrompts(): unknown {
    return { prompts: PROMPT_DEFINITIONS };
  }

  /** tools/call dispatch. */
  async callTool(params: unknown): Promise<ToolText> {
    const obj = asObject(params);
    const name = requireString(obj, "name");
    const args = asObject(obj.arguments);

    switch (name) {
      default:
        if (this.tools.has(name)) return this.callFileTool(name, args);
        throw new RpcError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
    }
  }

  private async callFileTool(name: string, args: Record<string, unknown>): Promise<ToolText> {
    const tool = this.tools.get(name);
    if (!tool) throw new RpcError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
    await ensureMemoryDir(this.root);

    // The tool runs under the per-root lock because write/edit/bash may mutate
    // the memory root and must keep MEMORY.md in sync.
    const result = await withLock(this.root, `mcp-${name}`, () => tool.handler(args, this.toolCtx));

    if (result === null) {
      return textResult("Memory store is busy (write lock held); please retry.", true);
    }
    if (!result.ok) {
      throw new RpcError(ErrorCode.InvalidParams, result.text);
    }
    return textResult(result.changed?.length ? `${result.text}\n${result.changed.join("\n")}` : result.text);
  }

  /** resources/read dispatch. */
  async readResource(params: unknown): Promise<unknown> {
    const obj = asObject(params);
    const uri = requireString(obj, "uri");

    if (uri === INDEX_RESOURCE_URI) {
      await ensureMemoryDir(this.root);
      const entries = await scanMemoryFiles(this.root);
      await syncMemoryIndex(this.root, entries);
      const index = await readMemoryIndex(this.root);
      return {
        contents: [{ uri, mimeType: "text/markdown", text: index }],
      };
    }

    if (uri === MANIFEST_RESOURCE_URI) {
      await ensureMemoryDir(this.root);
      const entries = await scanMemoryFiles(this.root);
      return {
        contents: [{ uri, mimeType: "text/plain", text: formatManifest(entries) }],
      };
    }

    throw new RpcError(ErrorCode.InvalidParams, `unknown resource uri: ${uri}`);
  }

  /** prompts/get dispatch. */
  async getPrompt(params: unknown): Promise<unknown> {
    const obj = asObject(params);
    const name = requireString(obj, "name");
    if (name !== WITH_MEMORY_PROMPT) {
      throw new RpcError(ErrorCode.InvalidParams, `unknown prompt: ${name}`);
    }

    await ensureMemoryDir(this.root);
    const entries = await scanMemoryFiles(this.root);
    await syncMemoryIndex(this.root, entries);
    const index = await readMemoryIndex(this.root);

    const rules = buildMemoryInstructionPrompt();
    const prelude = buildMemoryIndexPrompt(index);

    return {
      description: PROMPT_DEFINITIONS[0].description,
      messages: [
        {
          role: "user",
          content: { type: "text", text: `${rules}\n\n${prelude}` },
        },
      ],
    };
  }

  /**
   * Dispatch a single JSON-RPC request to its handler. Returns the response
   * payload, or null for notifications (which produce no response).
   */
  async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id: JsonRpcId = req.id ?? null;
    try {
      if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        if (isNotification(req)) return null;
        return makeError(id, ErrorCode.InvalidRequest, "invalid JSON-RPC request");
      }

      let result: unknown;
      switch (req.method) {
        case "initialize":
          result = this.handleInitialize();
          break;
        case "initialized":
        case "notifications/initialized":
          return null; // notification, no reply
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = this.listTools();
          break;
        case "tools/call":
          result = await this.callTool(req.params);
          break;
        case "resources/list":
          result = this.listResources();
          break;
        case "resources/read":
          result = await this.readResource(req.params);
          break;
        case "prompts/list":
          result = this.listPrompts();
          break;
        case "prompts/get":
          result = await this.getPrompt(req.params);
          break;
        default:
          if (isNotification(req)) return null;
          return makeError(id, ErrorCode.MethodNotFound, `method not found: ${req.method}`);
      }

      if (isNotification(req)) return null;
      return makeSuccess(id, result);
    } catch (err) {
      if (isNotification(req)) return null;
      return makeError(id, ...errorPayload(err));
    }
  }

  /** Whether initialize has been seen (exposed for transport / tests). */
  get isInitialized(): boolean {
    return this.initialized;
  }
}

function errorPayload(err: unknown): [number, string, unknown?] {
  if (err instanceof RpcError) {
    return [err.code, err.message, err.data];
  }
  if (err instanceof Error) {
    return [ErrorCode.InternalError, err.message];
  }
  return [ErrorCode.InternalError, "internal error"];
}
