#!/usr/bin/env node
/**
 * @memscribe/mcp-server — stdio JSON-RPC MCP server over @memscribe/core.
 *
 * Tools:     read, write, edit, bash, glob, grep
 * Resources: memscribe://index, memscribe://manifest
 * Prompt:    memscribe.with_memory
 *
 * Zero runtime dependencies. The memory root resolves via MEMSCRIBE_HOME or the
 * OS data dir (see @memscribe/core getMemoryRoot).
 */

export {
  MemScribeMcpServer,
  type ServerOptions,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  INDEX_RESOURCE_URI,
  MANIFEST_RESOURCE_URI,
  WITH_MEMORY_PROMPT,
} from "./server.js";

export { runStdioServer, type TransportOptions } from "./transport.js";

export {
  LineDecoder,
  encodeMessage,
  makeSuccess,
  makeError,
  ErrorCode,
  RpcError,
  JSONRPC_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcId,
} from "./protocol.js";

// CLI entry: start the stdio server when run directly.
import { fileURLToPath } from "node:url";
import { runStdioServer } from "./transport.js";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runStdioServer().catch((err: unknown) => {
    process.stderr.write(`memscribe-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
