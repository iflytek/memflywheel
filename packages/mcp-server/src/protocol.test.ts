import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LineDecoder,
  encodeMessage,
  makeSuccess,
  makeError,
  isNotification,
  ErrorCode,
  type JsonRpcRequest,
} from "./protocol.js";

test("encodeMessage produces one newline-delimited JSON line", () => {
  const line = encodeMessage(makeSuccess(1, { ok: true }));
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("makeError omits data when undefined", () => {
  const err = makeError(2, ErrorCode.MethodNotFound, "nope");
  assert.deepEqual(err, { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "nope" } });
});

test("LineDecoder splits on newlines and ignores blank lines", () => {
  const d = new LineDecoder();
  const out = d.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  assert.equal(out.length, 2);
  assert.equal(out[0].value?.id, 1);
  assert.equal(out[1].value?.id, 2);
});

test("LineDecoder buffers partial lines across chunks", () => {
  const d = new LineDecoder();
  assert.equal(d.push('{"jsonrpc":"2.0",').length, 0);
  const out = d.push('"id":7,"method":"ping"}\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].value?.id, 7);
});

test("LineDecoder surfaces malformed JSON as error", () => {
  const d = new LineDecoder();
  const out = d.push("not json\n");
  assert.equal(out.length, 1);
  assert.equal(out[0].error, "parse error");
  assert.equal(out[0].value, undefined);
});

test("LineDecoder strips trailing CR", () => {
  const d = new LineDecoder();
  const out = d.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].value?.id, 1);
});

test("isNotification true only when id absent", () => {
  const notif = { jsonrpc: "2.0", method: "x" } as JsonRpcRequest;
  const req = { jsonrpc: "2.0", id: 1, method: "x" } as JsonRpcRequest;
  assert.equal(isNotification(notif), true);
  assert.equal(isNotification(req), false);
});
