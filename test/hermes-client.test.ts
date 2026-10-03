import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { HermesApiError, HermesClient } from "../src/hermes-client.js";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

test("runTask forwards fake bearer auth, verbatim idempotency key, and the minimal body", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/runs");
    assert.equal(request.headers.authorization, "Bearer fake-secret");
    assert.equal(request.headers["idempotency-key"], "client-request/17");
    assert.deepEqual(JSON.parse(await readBody(request)), { input: "summarize", session_id: "session-1" });
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ run_id: "run-1", status: "started", replayed: false, ignored: "nope" }));
  }, async (origin) => {
    const client = new HermesClient(new URL(origin), "fake-secret");
    assert.deepEqual(await client.runTask({ task: "summarize", clientRequestId: "client-request/17", sessionId: "session-1" }), {
      run_id: "run-1", status: "started", replayed: false,
    });
  });
});

test("runTask returns Hermes replay status without retrying admission", async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    assert.equal(request.headers["idempotency-key"], "stable-id");
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ run_id: "run-1", status: "queued", replayed: true }));
  }, async (origin) => {
    const result = await new HermesClient(new URL(origin), "fake-secret").runTask({ task: "x", clientRequestId: "stable-id" });
    assert.deepEqual(result, { run_id: "run-1", status: "queued", replayed: true });
    assert.equal(requests, 1);
  });
});

test("runTask reports a conflict safely and never retries with another key", async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    assert.equal(request.headers["idempotency-key"], "original-key");
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "internal detail must not escape" } }));
  }, async (origin) => {
    await assert.rejects(
      () => new HermesClient(new URL(origin), "fake-secret").runTask({ task: "x", clientRequestId: "original-key" }),
      (error: unknown) => error instanceof HermesApiError && error.status === 409 && error.code === "upstream_conflict" && error.message === "Hermes API request failed (409)",
    );
    assert.equal(requests, 1);
  });
});

test("getStatus returns a narrow safe projection", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      run_id: "run-1", status: "waiting_for_approval", output: "done", error: "none",
      approval: { event: "approval.request", request_id: "approval-1", message: "allow?", raw_command: "secret" },
      internal: { token: "do-not-return" },
    }));
  }, async (origin) => {
    assert.deepEqual(await new HermesClient(new URL(origin), "fake-secret").getStatus("run-1"), {
      run_id: "run-1", status: "waiting_for_approval", output: "done", error: "none",
      approval: { event: "approval.request", request_id: "approval-1", message: "allow?" },
    });
  });
});

test("getStatus converts upstream failures into a safe structured error", async () => {
  await withServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("sensitive upstream diagnostic");
  }, async (origin) => {
    await assert.rejects(
      () => new HermesClient(new URL(origin), "fake-secret").getStatus("run-1"),
      (error: unknown) => error instanceof HermesApiError && error.status === 500 && error.message === "Hermes API request failed (500)",
    );
  });
});

test("getEvents parses partial SSE chunks, ignores comments, marks replay gaps, and stops at terminal", async () => {
  await withServer((_request, response) => {
    assert.equal(_request.headers["last-event-id"], "4");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": open\n\nid: 5\ndata: {\"event\":\"replay.trun");
    response.write("cated\",\"requested_seq\":4}\n\nid: 6\ndata: {\"event\":\"run.progress\",\"text\":\"hel");
    response.write("lo\",\"raw\":\"no\"}\n\nid: 7\ndata: {\"event\":\"run.completed\",\"output\":\"ok\"}\n\n");
    response.end();
  }, async (origin) => {
    const result = await new HermesClient(new URL(origin), "fake-secret").getEvents("run-1", 4, 500);
    assert.deepEqual(result, {
      events: [
        { seq: 5, event: "replay.truncated" },
        { seq: 6, event: "run.progress", text: "hello" },
        { seq: 7, event: "run.completed", output: "ok" },
      ],
      gap_detected: true,
      terminal: true,
    });
  });
});

test("getEvents preserves UTF-8 text split across SSE chunks", async () => {
  const frame = Buffer.from("id: 1\ndata: {\"event\":\"run.completed\",\"text\":\"€\"}\n\n");
  const euroStart = frame.indexOf(Buffer.from("€"));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame.subarray(0, euroStart + 1));
      controller.enqueue(frame.subarray(euroStart + 1));
      controller.close();
    },
  });
  const client = new HermesClient(new URL("http://127.0.0.1:1"), "fake-secret", async () => new Response(stream));
  const result = await client.getEvents("run-1", undefined, 500);
  assert.deepEqual(result.events, [{ seq: 1, event: "run.completed", text: "€" }]);
});

test("getEvents returns after the requested wait timeout", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": open\n\n");
  }, async (origin) => {
    const result = await new HermesClient(new URL(origin), "fake-secret").getEvents("run-1", undefined, 20);
    assert.deepEqual(result, { events: [], gap_detected: false, terminal: false });
  });
});

test("getEvents caps exposed events at one hundred", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 1; index <= 101; index += 1) response.write(`id: ${index}\ndata: {"event":"run.progress","text":"${index}"}\n\n`);
    response.end();
  }, async (origin) => {
    const result = await new HermesClient(new URL(origin), "fake-secret").getEvents("run-1", undefined, 500);
    assert.equal(result.events.length, 100);
    assert.equal(result.events[99]?.seq, 100);
  });
});

test("stop posts to the run stop endpoint and projects its result", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/runs/run-1/stop");
    assert.equal(request.headers.authorization, "Bearer fake-secret");
    assert.equal(await readBody(request), "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ run_id: "run-1", status: "stopping", extra: true }));
  }, async (origin) => {
    assert.deepEqual(await new HermesClient(new URL(origin), "fake-secret").stop("run-1"), { run_id: "run-1", status: "stopping" });
  });
});

test("runTask reports ambiguous admission after a transport failure", async () => {
  const client = new HermesClient(
    new URL("http://127.0.0.1:1"),
    "fake-secret",
    async () => { throw new TypeError("socket closed"); },
  );
  await assert.rejects(
    () => client.runTask({ task: "x", clientRequestId: "stable-id" }),
    (error: unknown) =>
      error instanceof HermesApiError
      && error.code === "ambiguous_admission"
      && error.message === "Hermes run admission outcome is unknown",
  );
});

test("getEvents treats run.interrupted as terminal", async () => {
  const body = 'id: 1\ndata: {"event":"run.interrupted","error":"restart"}\n\n';
  const client = new HermesClient(
    new URL("http://127.0.0.1:1"),
    "fake-secret",
    async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  const result = await client.getEvents("run-1", undefined, 500);
  assert.equal(result.terminal, true);
  assert.deepEqual(result.events, [{ seq: 1, event: "run.interrupted", error: "restart" }]);
});

test("runTask treats malformed HTTP 202 body as ambiguous admission", async () => {
  const client = new HermesClient(
    new URL("http://127.0.0.1:1"),
    "fake-secret",
    async () => new Response('{"run_id":"run-1"', {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(
    () => client.runTask({ task: "x", clientRequestId: "stable-id" }),
    (error: unknown) =>
      error instanceof HermesApiError
      && error.code === "ambiguous_admission"
      && error.message === "Hermes run admission outcome is unknown",
  );
});

test("runTask treats an invalid successful admission payload as ambiguous", async () => {
  const client = new HermesClient(
    new URL("http://127.0.0.1:1"),
    "fake-secret",
    async () => new Response(JSON.stringify({ status: "started", replayed: false }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(
    () => client.runTask({ task: "x", clientRequestId: "stable-id" }),
    (error: unknown) => error instanceof HermesApiError && error.code === "ambiguous_admission",
  );
});

test("getEvents preserves Hermes message.delta content", async () => {
  const body = 'id: 9\ndata: {"event":"message.delta","delta":"hello"}\n\n';
  const client = new HermesClient(
    new URL("http://127.0.0.1:1"),
    "fake-secret",
    async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  const result = await client.getEvents("run-1", undefined, 500);
  assert.deepEqual(result.events, [{ seq: 9, event: "message.delta", delta: "hello" }]);
});

test("Hermes HTTP requests refuse redirects before following them", async () => {
  let redirectedRequests = 0;
  await withServer((_redirectedRequest, redirectedResponse) => {
    redirectedRequests += 1;
    redirectedResponse.writeHead(200, { "content-type": "application/json" });
    redirectedResponse.end(JSON.stringify({ run_id: "run-1", status: "running" }));
  }, async (redirectOrigin) => {
    await withServer((_request, response) => {
      response.writeHead(302, { location: `${redirectOrigin}/v1/runs/run-1` });
      response.end();
    }, async (origin) => {
      await assert.rejects(
        () => new HermesClient(new URL(origin), "fake-secret").getStatus("run-1"),
        (error: unknown) => error instanceof HermesApiError && error.code === "network_error",
      );
    });
  });
  assert.equal(redirectedRequests, 0);
});
