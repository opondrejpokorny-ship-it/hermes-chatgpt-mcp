import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
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

async function startGateway(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: new URL(`http://127.0.0.1:${address.port}/api`) };
}

async function stop(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

async function getJson(port: number, path: string, host = "127.0.0.1") {
  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let parsed: unknown = null;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function startAdapterForGateway(gatewayUrl: URL) {
  const server = await startHttpServer({
    hermesApiUrl: gatewayUrl,
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

test("loopback health endpoint returns the minimal healthy payload", async () => {
  const { server, port } = await startTestServer();
  try {
    assert.deepEqual(await getJson(port, "/healthz"), { status: 200, body: { status: "ok" } });
  } finally {
    await stop(server);
  }
});

test("readiness endpoint accepts only Hermes health status ok", async () => {
  const gateway = await startGateway((request, response) => {
    assert.equal(request.url, "/health");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", platform: "hermes-agent" }));
  });
  const adapter = await startAdapterForGateway(gateway.url);
  try {
    assert.deepEqual(await getJson(adapter.port, "/readyz"), { status: 200, body: { status: "ready" } });
  } finally {
    await stop(adapter.server);
    await stop(gateway.server);
  }
});

test("readiness endpoint masks a non-ready upstream response", async () => {
  const gateway = await startGateway((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "starting", diagnostic: "must-not-leak" }));
  });
  const adapter = await startAdapterForGateway(gateway.url);
  try {
    assert.deepEqual(await getJson(adapter.port, "/readyz"), { status: 503, body: { status: "not_ready" } });
  } finally {
    await stop(adapter.server);
    await stop(gateway.server);
  }
});

test("readiness endpoint refuses redirects and times out bounded probes", async () => {
  const redirectGateway = await startGateway((_request, response) => {
    response.writeHead(302, { location: "http://127.0.0.1:1/health" }).end();
  });
  const redirectAdapter = await startAdapterForGateway(redirectGateway.url);
  const slowGateway = await startGateway(() => undefined);
  const slowAdapter = await startAdapterForGateway(slowGateway.url);
  try {
    assert.deepEqual(await getJson(redirectAdapter.port, "/readyz"), { status: 503, body: { status: "not_ready" } });
    const started = Date.now();
    assert.deepEqual(await getJson(slowAdapter.port, "/readyz"), { status: 503, body: { status: "not_ready" } });
    assert.ok(Date.now() - started <= 2_200, "readiness timeout must remain bounded near two seconds");
  } finally {
    await stop(redirectAdapter.server);
    await stop(redirectGateway.server);
    await stop(slowAdapter.server);
    await stop(slowGateway.server);
  }
});

test("health and readiness endpoints reject non-loopback Host headers", async () => {
  const { server, port } = await startTestServer();
  try {
    for (const path of ["/healthz", "/readyz"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: { host: "evil.example" } }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        });
        request.on("error", reject);
        request.end();
      });
      assert.equal(status, 403);
    }
  } finally {
    await stop(server);
  }
});
