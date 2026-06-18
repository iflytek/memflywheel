/**
 * stdio transport: bridge a MemScribeMcpServer to newline-delimited JSON-RPC over
 * a readable/writable stream pair (defaults to process.stdin / process.stdout).
 *
 * Decoupled from `process` so it can be driven by in-memory streams in tests.
 */

import type { Readable, Writable } from "node:stream";

import { MemScribeMcpServer, type ServerOptions } from "./server.js";
import {
  LineDecoder,
  encodeMessage,
  makeError,
  ErrorCode,
  type JsonRpcRequest,
} from "./protocol.js";

export interface TransportOptions extends ServerOptions {
  input?: Readable;
  output?: Writable;
}

/**
 * Run the server over the given streams. Resolves when the input stream ends.
 * Requests are dispatched in receipt order; responses are written as soon as
 * each dispatch resolves (per-line sequencing is preserved because dispatch is
 * awaited before the next line is processed).
 */
export function runStdioServer(options: TransportOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const server = new MemScribeMcpServer(options);
  const decoder = new LineDecoder();

  return new Promise<void>((resolve, reject) => {
    let queue: Promise<void> = Promise.resolve();

    const write = (line: string): void => {
      output.write(line);
    };

    const handleItem = async (item: {
      value?: JsonRpcRequest;
      error?: string;
      raw: string;
    }): Promise<void> => {
      if (item.error || !item.value) {
        write(encodeMessage(makeError(null, ErrorCode.ParseError, "parse error")));
        return;
      }
      try {
        const response = await server.dispatch(item.value);
        if (response) write(encodeMessage(response));
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        const id = item.value.id ?? null;
        write(encodeMessage(makeError(id, ErrorCode.InternalError, message)));
      }
    };

    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      const items = decoder.push(chunk);
      for (const item of items) {
        queue = queue.then(() => handleItem(item));
      }
    });
    input.on("error", (err) => reject(err));
    input.on("end", () => {
      queue.then(() => resolve()).catch(reject);
    });
    input.on("close", () => {
      queue.then(() => resolve()).catch(reject);
    });
  });
}
