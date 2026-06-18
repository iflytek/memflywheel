/**
 * MemScribe MCP server: dispatch + tool / resource / prompt handlers, plus the
 * stdio transport runner.
 *
 * Tool face (deliberately minimal — NO search tool):
 *   - memory_context : full MEMORY.md prelude (the two-segment recall payload)
 *   - memory_read    : read one memory document body by relativePath
 *   - memory_save    : direct write of one memory document (the same core write
 *                      tool the extraction subagent uses; path derived from name)
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
  buildContext,
  buildMemoryInstructionPrompt,
  buildMemoryIndexPrompt,
  readMemoryIndex,
  readMemoryDocument,
  scanMemoryFiles,
  syncMemoryIndex,
  formatManifest,
  ensureMemoryDir,
  getMemoryRoot,
  withLock,
  createAuditLogger,
  createMemoryTools,
  memoryToolMap,
  InvalidMemoryError,
  SecretRefusedError,
  type StorageContext,
  type MemoryTool,
  type MemoryToolContext,
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
  /**
   * Hard secret gate for memory_save. Defaults to TRUE for the MCP face: an
   * external MCP client is less trusted than the in-loop extraction subagent, so
   * secrets are refused rather than written. <private> redaction is always on.
   */
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

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new RpcError(ErrorCode.InvalidParams, `param ${key} must be a string`);
  }
  return v;
}

/** Tool descriptors advertised via tools/list. */
const TOOL_DEFINITIONS = [
  {
    name: "memory_context",
    description:
      "Return the full memory context prelude (stable rules + the complete MEMORY.md index). " +
      "There is no search: the entire index is returned and the caller decides which files to read.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_read",
    description:
      "Read one memory document body by its relativePath (e.g. \"context/project.md\"), as listed in the index. " +
      "Returns the markdown body without frontmatter.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: {
          type: "string",
          description: "Relative path of the memory file under the memory root.",
        },
      },
      required: ["relativePath"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_save",
    description:
      "Save (create or overwrite) one memory document directly. The file path is derived from the name. " +
      "Privacy redaction (and, for this MCP face, secret refusal) are enforced; the MEMORY.md index is re-synced after the write.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["identity", "preference", "style", "workflow", "context", "ambient"],
          description: "Memory category.",
        },
        name: { type: "string", description: "Short single-line title stored in frontmatter; the file path is derived from it." },
        description: {
          type: "string",
          description: "Optional single-line summary stored in frontmatter.",
        },
        body: { type: "string", description: "Markdown body of the memory." },
      },
      required: ["type", "name", "body"],
      additionalProperties: false,
    },
  },
] as const;

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
  private readonly toolCtx: MemoryToolContext;
  private readonly saveTool: MemoryTool;
  private initialized = false;

  constructor(options: ServerOptions = {}) {
    this.root = getMemoryRoot({ root: options.root });
    this.storage = { root: this.root, audit: createAuditLogger(this.root) };
    // An external MCP client is less trusted than the in-loop subagent, so the
    // hard secret gate defaults ON for this face.
    this.toolCtx = { ctx: this.storage, refuseSecrets: options.refuseSecrets !== false };
    const tools = memoryToolMap(createMemoryTools());
    const save = tools.get("memory_save");
    if (!save) throw new Error("core did not provide a memory_save tool");
    this.saveTool = save;
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
      case "memory_context":
        return this.toolMemoryContext();
      case "memory_read":
        return this.toolMemoryRead(args);
      case "memory_save":
        return this.toolMemorySave(args);
      default:
        throw new RpcError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
    }
  }

  private async toolMemoryContext(): Promise<ToolText> {
    await ensureMemoryDir(this.root);
    const ctx = await buildContext({ root: this.root });
    const text = `${ctx.systemPrompt}\n\n${ctx.preludePrompt}`;
    return textResult(text);
  }

  private async toolMemoryRead(args: Record<string, unknown>): Promise<ToolText> {
    const relativePath = requireString(args, "relativePath");
    const doc = await readMemoryDocument(this.storage, relativePath);
    if (!doc) {
      return textResult(`No memory found at: ${relativePath}`, true);
    }
    return textResult(doc.body);
  }

  private async toolMemorySave(args: Record<string, unknown>): Promise<ToolText> {
    // Validate the required string params up front for clean InvalidParams errors;
    // the core save handler then derives the path from name, redacts <private>,
    // applies the (default-on) secret gate, writes atomically, and resyncs the index.
    const type = requireString(args, "type");
    const name = requireString(args, "name");
    const description = optionalString(args, "description") ?? "";
    const body = requireString(args, "body");

    await ensureMemoryDir(this.root);

    // The whole save runs under the per-root write lock (the core handler assumes
    // the caller holds it). A busy lock returns null.
    const result = await withLock(this.root, "mcp-save", () =>
      this.saveTool.handler({ type, name, description, body }, this.toolCtx),
    );

    if (result === null) {
      return textResult("Memory store is busy (write lock held); please retry.", true);
    }
    if (!result.ok) {
      // Surface refusals / validation failures as a JSON-RPC InvalidParams error
      // so external clients get a structured failure rather than a silent skip.
      throw new RpcError(ErrorCode.InvalidParams, result.text);
    }
    return textResult(`Saved memory: ${result.changed?.[0] ?? result.text}`);
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
  if (err instanceof InvalidMemoryError) {
    return [ErrorCode.InvalidParams, err.message];
  }
  if (err instanceof SecretRefusedError) {
    return [ErrorCode.InvalidParams, err.message];
  }
  if (err instanceof Error) {
    return [ErrorCode.InternalError, err.message];
  }
  return [ErrorCode.InternalError, "internal error"];
}
