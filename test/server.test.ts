import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { HermesApiError } from "../src/hermes-client.js";
import { createMcpServer } from "../src/server.js";

const fakeClient = {
  runTask: async () => ({ run_id: "run-1", status: "queued", replayed: false }),
  getStatus: async () => ({ run_id: "run-1", status: "running" }),
  getEvents: async () => ({ events: [], gap_detected: false, terminal: false }),
  stop: async () => ({ run_id: "run-1", status: "stopping" }),
};

async function connectedServer() {
  const server = createMcpServer(fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("MCP server exposes exactly the four approved tools with safe annotations", async () => {
  const { client, server } = await connectedServer();
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["get_events", "get_status", "run_task", "stop"]);
    const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.get("run_task")?.annotations, { readOnlyHint: false, openWorldHint: false });
    assert.deepEqual(byName.get("get_status")?.annotations, { readOnlyHint: true, openWorldHint: false });
    assert.deepEqual(byName.get("get_events")?.annotations, { readOnlyHint: true, openWorldHint: false });
    assert.deepEqual(byName.get("stop")?.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    assert.equal(byName.get("run_task")?.inputSchema.properties.task.type, "string");
    assert.equal(byName.get("run_task")?.inputSchema.properties.client_request_id.type, "string");
    assert.equal(byName.get("get_events")?.inputSchema.properties.wait_ms.maximum, 30_000);
  } finally {
    await server.close();
  }
});

test("MCP run_task maps snake-case arguments to the Hermes client without secrets", async () => {
  const calls: unknown[] = [];
  const server = createMcpServer({ ...fakeClient, runTask: async (input) => {
    calls.push(input);
    return { run_id: "run-9", status: "started", replayed: false };
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "run_task", arguments: { task: "hello", client_request_id: "request-9", session_id: "session-9" } });
    assert.deepEqual(calls, [{ task: "hello", clientRequestId: "request-9", sessionId: "session-9" }]);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { run_id: "run-9", status: "started", replayed: false });
  } finally {
    await server.close();
  }
});

test("MCP run_task rejects a non-visible-ASCII idempotency key", async () => {
  const { client, server } = await connectedServer();
  try {
    const result = await client.callTool({
      name: "run_task",
      arguments: { task: "hello", client_request_id: "contains space" },
    });
    assert.equal(result.isError, true);
  } finally {
    await server.close();
  }
});

test("MCP errors expose safe structured retry semantics", async () => {
  const server = createMcpServer({
    ...fakeClient,
    runTask: async () => { throw new HermesApiError("ambiguous_admission"); },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "run_task",
      arguments: { task: "hello", client_request_id: "request-9" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: {
        kind: "ambiguous_admission",
        message: "Hermes run admission outcome is unknown",
        retryable: true,
        retry_with_same_client_request_id: true,
      },
    });
  } finally {
    await server.close();
  }
});
