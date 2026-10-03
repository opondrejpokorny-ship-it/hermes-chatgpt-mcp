import { createServer, type Server as HttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { isLoopbackHost, type AdapterConfig } from "./config.js";
import { HermesApiError, HermesClient, type EventsResult, type RunAdmission, type RunStatus } from "./hermes-client.js";

export interface HermesToolClient {
  runTask(input: { task: string; clientRequestId: string; sessionId?: string }): Promise<RunAdmission>;
  getStatus(runId: string): Promise<RunStatus>;
  getEvents(runId: string, afterSeq?: number, waitMs?: number): Promise<EventsResult>;
  stop(runId: string): Promise<Pick<RunStatus, "run_id" | "status">>;
}

const safeAnnotations = { openWorldHint: false } as const;
const readinessTimeoutMs = 2_000;

function sendJson(response: import("node:http").ServerResponse, status: number, body: Record<string, string>) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function isHermesReady(hermesApiUrl: URL): Promise<boolean> {
  try {
    const healthUrl = new URL("/health", hermesApiUrl.origin);
    const response = await fetch(healthUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(readinessTimeoutMs),
    });
    if (response.status !== 200) return false;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && (body as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

function textResult(value: unknown) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

function toolFailure(error: unknown) {
  let details: Record<string, unknown> = {
    kind: "internal_error",
    message: "Hermes API request failed",
    retryable: false,
  };
  if (error instanceof HermesApiError) {
    if (error.code === "ambiguous_admission") {
      details = {
        kind: "ambiguous_admission",
        message: error.message,
        retryable: true,
        retry_with_same_client_request_id: true,
      };
    } else if (error.code === "network_error") {
      details = { kind: "hermes_unavailable", message: error.message, retryable: true };
    } else if (error.code === "upstream_conflict") {
      details = { kind: "conflict", message: error.message, retryable: false, http_status: error.status };
    } else {
      const status = error.status;
      const kind = status === 400 ? "invalid_input"
        : status === 401 || status === 403 ? "adapter_authentication_failed"
        : status === 404 ? "run_not_found"
        : status === 429 ? "capacity_limited"
        : status !== undefined && status >= 500 ? "hermes_unavailable"
        : "upstream_error";
      details = {
        kind,
        message: error.message,
        retryable: status === 429 || (status !== undefined && status >= 500),
        ...(status === undefined ? {} : { http_status: status }),
      };
    }
  }
  const structuredContent = { error: details };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

export function createMcpServer(client: HermesToolClient): McpServer {
  const server = new McpServer({ name: "hermes-runtime-adapter", version: "0.1.0" });

  server.registerTool("run_task", {
    title: "Run Hermes task",
    description: "Admit one Hermes task using the supplied idempotency key.",
    inputSchema: {
      task: z.string().min(1).max(20_000),
      client_request_id: z.string().regex(/^[\x21-\x7E]{1,255}$/, "client_request_id must be 1-255 visible ASCII characters"),
      session_id: z.string().min(1).max(255).optional(),
    },
    annotations: { readOnlyHint: false, ...safeAnnotations },
  }, async ({ task, client_request_id, session_id }) => {
    try {
      return textResult(await client.runTask({ task, clientRequestId: client_request_id, sessionId: session_id }));
    } catch (error) {
      return toolFailure(error);
    }
  });

  server.registerTool("get_status", {
    title: "Get Hermes task status",
    description: "Read the compact safe status for a Hermes run.",
    inputSchema: { run_id: z.string().min(1).max(255) },
    annotations: { readOnlyHint: true, ...safeAnnotations },
  }, async ({ run_id }) => {
    try {
      return textResult(await client.getStatus(run_id));
    } catch (error) {
      return toolFailure(error);
    }
  });

  server.registerTool("get_events", {
    title: "Get Hermes task events",
    description: "Read up to one hundred safe events from a Hermes run replay stream.",
    inputSchema: {
      run_id: z.string().min(1).max(255),
      after_seq: z.number().int().min(0).optional(),
      wait_ms: z.number().int().min(0).max(30_000).optional(),
    },
    annotations: { readOnlyHint: true, ...safeAnnotations },
  }, async ({ run_id, after_seq, wait_ms }) => {
    try {
      return textResult(await client.getEvents(run_id, after_seq, wait_ms));
    } catch (error) {
      return toolFailure(error);
    }
  });

  server.registerTool("stop", {
    title: "Stop Hermes task",
    description: "Request cooperative stopping of a Hermes run.",
    inputSchema: { run_id: z.string().min(1).max(255) },
    annotations: { readOnlyHint: false, destructiveHint: true, ...safeAnnotations },
  }, async ({ run_id }) => {
    try {
      return textResult(await client.stop(run_id));
    } catch (error) {
      return toolFailure(error);
    }
  });

  return server;
}

export async function startHttpServer(config: AdapterConfig, client: HermesToolClient = new HermesClient(config.hermesApiUrl, config.hermesApiKey)): Promise<HttpServer> {
  const httpServer = createServer((request, response) => {
    const host = request.headers.host;
    let hostAllowed = false;
    if (host) {
      try {
        hostAllowed = isLoopbackHost(new URL(`http://${host}`).hostname);
      } catch {
        hostAllowed = false;
      }
    }
    if (!hostAllowed) {
      response.writeHead(403).end();
      return;
    }

    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      void isHermesReady(config.hermesApiUrl).then((ready) => {
        sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
      });
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }

    const mcpServer = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    void mcpServer.connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  return httpServer;
}
