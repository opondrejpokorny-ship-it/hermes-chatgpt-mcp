import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startHttpServer } from "../src/server.js";

const fakeClient = {
  runTask: async () => ({ run_id: "run-1", status: "queued", replayed: false }),
  getStatus: async () => ({ run_id: "run-1", status: "running" }),
  getEvents: async () => ({ events: [], gap_detected: false, terminal: false }),
  stop: async () => ({ run_id: "run-1", status: "stopping" }),
};

async function startTestServer() {
  const server = await startHttpServer({
    hermesApiUrl: new URL("http://127.0.0.1:8642"),
    hermesApiKey: "x".repeat(32),
    port: 0,
  }, fakeClient);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}

test("Streamable HTTP /mcp serves the four MCP tools", async () => {
  const { server, port } = await startTestServer();
  const client = new Client({ name: "http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "get_events", "get_status", "run_task", "stop",
    ]);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP endpoint rejects a non-loopback Host header", async () => {
  const { server, port } = await startTestServer();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
        headers: { host: "evil.example", "content-type": "application/json" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end("{}");
    });
    assert.equal(status, 403);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});
