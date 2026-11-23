/**
 * Convert a ClickHouse MCP DESCRIBE result into a host-owned extraction message.
 * The caller owns the MCP client, live query, model binding, and memory lifecycle.
 */
export function createClickHouseSchemaMessage(result, { table, observedAt }) {
  if (!result || result.isError) {
    throw new Error("Cannot remember a failed ClickHouse schema query");
  }
  if (typeof table !== "string" || !table.trim()) {
    throw new Error("The described table is required");
  }
  if (
    typeof observedAt !== "string" ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new Error("A schema observation timestamp with a time zone is required");
  }

  let payload = result.structuredContent;
  if (payload === undefined) {
    payload = result.content?.find((item) => item.type === "text")?.text;
  } else if (payload && Object.hasOwn(payload, "result")) {
    payload = payload.result;
  }
  if (typeof payload === "string") payload = JSON.parse(payload);
  if (!Array.isArray(payload?.columns) || !Array.isArray(payload?.rows)) {
    throw new Error("Expected a tabular ClickHouse DESCRIBE result");
  }

  const nameIndex = payload.columns.indexOf("name");
  const typeIndex = payload.columns.indexOf("type");
  if (nameIndex < 0 || typeIndex < 0) {
    throw new Error("DESCRIBE result is missing name/type headings");
  }
  const names = new Set();
  const columns = payload.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== payload.columns.length) {
      throw new Error("Malformed ClickHouse DESCRIBE row");
    }
    const name = row[nameIndex];
    const type = row[typeIndex];
    if (typeof name !== "string" || typeof type !== "string" || !name || !type || names.has(name)) {
      throw new Error("Invalid or duplicate described column");
    }
    names.add(name);
    return { name, type };
  });
  if (!columns.length) throw new Error("Cannot remember an empty schema");

  const observedAtUtc = new Date(observedAt).toISOString();
  return {
    role: "assistant",
    timestamp: observedAtUtc,
    text:
      "Observed the current ClickHouse table schema. This is a historical " +
      "snapshot: verify the live schema and permissions before reusing SQL. " +
      "A date filter in a query is not the schema observation date.",
    toolCalls: [
      {
        name: "clickhouse.describe_table",
        input: { table },
        output: {
          kind: "clickhouse_table_schema",
          table,
          observed_at_utc: observedAtUtc,
          columns,
        },
      },
    ],
  };
}
