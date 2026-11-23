# ClickHouse MCP schema observations

This host-side adapter turns a successful ClickHouse MCP `DESCRIBE` response
into an `ExtractionMessage` for MemFlywheel. The host keeps its existing MCP
client, model binding, credentials, and lifecycle hooks.

## Why project the response

`DESCRIBE TABLE analytics.orders` returns a table whose headings include `name`,
`type`, and `default_expression`. The described business fields are in its rows.
Passing that envelope straight into an extraction model can cause it to remember
the response headings as business fields. A query date such as `2026-11-01` can
also be confused with the date the schema was observed.

`createClickHouseSchemaMessage` makes those distinctions explicit:

- `columns` contains the described field names and types, taken from the rows.
- `observed_at_utc` and the message timestamp come from the caller's actual
  observation time, never a query predicate or an invented default.
- Failed queries and malformed schema results throw before memory extraction.

The adapter accepts JSON text results, direct structured tables, and FastMCP's
`structuredContent.result` wrapper. It adds no dependencies and does not change
the ClickHouse MCP protocol or MemFlywheel core.

## Connect to the host lifecycle

The host has already connected `mcp` to the official
[ClickHouse MCP server](https://github.com/ClickHouse/mcp-clickhouse) and created
`memory` with its active model's extraction runner. At the successful schema
query boundary:

```js
import { createClickHouseSchemaMessage } from "./schema-memory.mjs";

const result = await mcp.callTool({
  name: "run_query",
  arguments: { query: "DESCRIBE TABLE analytics.orders" },
});
const schemaMessage = createClickHouseSchemaMessage(result, {
  table: "analytics.orders",
  observedAt: new Date().toISOString(),
});

await memory.onTurnEnd(sessionId, [
  {
    role: "user",
    text: "Remember the verified orders schema for future analysis, not row data or totals.",
    timestamp: schemaMessage.timestamp,
  },
  schemaMessage,
]);
```

Use the host's real user instruction and existing turn-end hook; the snippet's
instruction is illustrative. Do not call `onTurnEnd` twice for the same turn.
`memory` needs an extraction runner: without one, the SDK is recall-only and no
automatic memory write occurs. Table names can themselves be sensitive; apply
the host's data policy before handing a schema observation to its model.

## Revalidation and measurement

This records a historical snapshot. It neither invalidates old memory nor checks
whether remembered SQL uses the current columns. Re-read the live schema and
validate the query before reusing it; a renamed column can still be suggested
after a model has seen the new schema. `DESCRIBE TABLE` alone does not establish
the caller's privileges for a future query.

For a memory comparison, keep model settings, business definitions, tools, and
behavior rules aligned. Confirm extraction wrote a real memory file and that
the agent actually consumed the relevant memory. Count extraction and recall
overhead separately, preserve failed attempts, and test a schema change. This
example makes no task-success, latency, or cost-improvement claim.

Run the offline protocol regressions from the repository root:

```sh
pnpm --dir examples test
```

The fixture shape was checked against official `mcp-clickhouse` 0.7.0 and
ClickHouse Playground 26.10.3.7. Hosted Spark-X2.6-4B was used for the integration
pilot; the adapter itself has no model-specific code.
