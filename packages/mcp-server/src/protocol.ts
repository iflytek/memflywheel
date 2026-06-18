/**
 * Minimal JSON-RPC 2.0 framing for the MCP stdio transport.
 *
 * MCP over stdio uses newline-delimited JSON-RPC 2.0 messages: each message is a
 * single JSON value terminated by "\n", with no embedded newlines. This module
 * is pure (no process / stream coupling) so it can be unit-tested directly.
 */

export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** Standard JSON-RPC error codes (plus MCP convention). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function makeSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function makeError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcError["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/** Serialize a message as one newline-delimited JSON line. */
export function encodeMessage(message: JsonRpcResponse): string {
  return JSON.stringify(message) + "\n";
}

/** True if the parsed object is a notification (no id → no response expected). */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

/**
 * Incremental newline-delimited JSON decoder. Feed raw chunks; receive complete
 * parsed messages. Blank lines are ignored. Malformed lines surface as the
 * `error` field on the yielded item so the caller can emit a ParseError.
 */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): Array<{ value?: JsonRpcRequest; error?: string; raw: string }> {
    this.buffer += chunk;
    const out: Array<{ value?: JsonRpcRequest; error?: string; raw: string }> = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim() === "") continue;
      try {
        out.push({ value: JSON.parse(line) as JsonRpcRequest, raw: line });
      } catch {
        out.push({ error: "parse error", raw: line });
      }
    }
    return out;
  }
}
