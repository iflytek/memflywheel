import { test } from "node:test";
import assert from "node:assert/strict";

import { createClickHouseSchemaMessage } from "./schema-memory.mjs";

// The result headings describe the DESCRIBE response, not the user's table.
const describe = {
  columns: ["name", "type", "default_type", "default_expression", "comment"],
  rows: [
    ["id", "UInt32", "", "", ""],
    ["day", "Date", "", "", ""],
    ["gross_cents", "UInt32", "", "", ""],
  ],
};
const options = {
  table: "analytics.orders",
  observedAt: "2026-11-23T12:00:00+08:00",
};

test("projects DESCRIBE rows into business columns, not response headings", () => {
  const message = createClickHouseSchemaMessage(
    { structuredContent: { result: JSON.stringify(describe) } },
    options,
  );
  assert.deepEqual(message.toolCalls[0].output.columns, [
    { name: "id", type: "UInt32" },
    { name: "day", type: "Date" },
    { name: "gross_cents", type: "UInt32" },
  ]);
  assert.equal(message.role, "assistant");
  assert.equal(message.timestamp, "2026-11-23T04:00:00.000Z");
  assert.equal(message.toolCalls[0].output.observed_at_utc, message.timestamp);
  assert.deepEqual(message.toolCalls[0].input, { table: "analytics.orders" });
});

test("legacy text and structured result wrappers produce the same message", () => {
  const expected = createClickHouseSchemaMessage({ structuredContent: describe }, options);
  assert.deepEqual(
    createClickHouseSchemaMessage(
      { content: [{ type: "text", text: JSON.stringify(describe) }] },
      options,
    ),
    expected,
  );
  assert.deepEqual(
    createClickHouseSchemaMessage(
      { structuredContent: { result: JSON.stringify(describe) } },
      options,
    ),
    expected,
  );
});

test("business columns named name/type are preserved and heading order is respected", () => {
  const message = createClickHouseSchemaMessage(
    {
      structuredContent: {
        columns: ["type", "name"],
        rows: [
          ["String", "name"],
          ["UInt8", "type"],
        ],
      },
    },
    options,
  );
  assert.deepEqual(message.toolCalls[0].output.columns, [
    { name: "name", type: "String" },
    { name: "type", type: "UInt8" },
  ]);
});

test("failed and malformed results do not become schema observations", () => {
  for (const result of [
    null,
    { isError: true, structuredContent: describe },
    { structuredContent: { result: "not json" } },
    { structuredContent: { columns: ["wrong"], rows: [] } },
    { structuredContent: { columns: ["name", "type"], rows: [] } },
    { structuredContent: { columns: ["name", "type"], rows: [["id"]] } },
    { structuredContent: { columns: ["name", "type"], rows: [["id", 123]] } },
    {
      structuredContent: {
        columns: ["name", "type"],
        rows: [
          ["id", "UInt32"],
          ["id", "String"],
        ],
      },
    },
  ]) {
    assert.throws(() => createClickHouseSchemaMessage(result, options));
  }
});

test("observation time must be supplied explicitly, not inferred from a query date", () => {
  for (const observedAt of [undefined, "2026-11-01", "2026-11-01T12:00:00", "invalid"]) {
    assert.throws(() =>
      createClickHouseSchemaMessage({ structuredContent: describe }, { ...options, observedAt }),
    );
  }
});
