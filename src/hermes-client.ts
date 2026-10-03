const MAX_EVENTS = 100;
const MAX_TEXT_LENGTH = 4_000;
const MAX_WAIT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export class HermesApiError extends Error {
  constructor(
    public readonly code: "ambiguous_admission" | "upstream_conflict" | "upstream_error" | "network_error",
    public readonly status?: number,
  ) {
    super(
      code === "ambiguous_admission"
        ? "Hermes run admission outcome is unknown"
        : status === undefined
          ? "Hermes API request failed"
          : `Hermes API request failed (${status})`,
    );
    this.name = "HermesApiError";
  }
}

export interface RunTaskInput {
  task: string;
  clientRequestId: string;
  sessionId?: string;
}

export interface RunAdmission {
  run_id: string;
  status: string;
  replayed: boolean;
}

export interface SafeApproval {
  event?: string;
  request_id?: string;
  message?: string;
}

export interface RunStatus {
  run_id: string;
  status: string;
  output?: string;
  error?: string;
  approval?: SafeApproval;
}

export interface SafeEvent {
  seq?: number;
  event: string;
  text?: string;
  delta?: string;
  output?: string;
  error?: string;
  approval?: SafeApproval;
}

export interface EventsResult {
  events: SafeEvent[];
  gap_detected: boolean;
  terminal: boolean;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, MAX_TEXT_LENGTH);
}

function requiredText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT_LENGTH) : fallback;
}

function safeApproval(value: unknown): SafeApproval | undefined {
  const source = record(value);
  const approval: SafeApproval = {};
  for (const key of ["event", "request_id", "message"] as const) {
    const text = boundedText(source[key]);
    if (text !== undefined) approval[key] = text;
  }
  return Object.keys(approval).length > 0 ? approval : undefined;
}

function safeStatus(value: unknown): RunStatus {
  const source = record(value);
  const status: RunStatus = {
    run_id: requiredText(source.run_id, "unknown"),
    status: requiredText(source.status, "unknown"),
  };
  for (const key of ["output", "error"] as const) {
    const text = boundedText(source[key]);
    if (text !== undefined) status[key] = text;
  }
  const approval = safeApproval(source.approval);
  if (approval) status.approval = approval;
  return status;
}

function safeEvent(value: unknown, id?: string): SafeEvent | undefined {
  const source = record(value);
  const event = boundedText(source.event);
  if (!event) return undefined;
  const result: SafeEvent = { event };
  const parsedId = Number(id ?? source.seq);
  if (Number.isSafeInteger(parsedId) && parsedId >= 0) result.seq = parsedId;
  for (const key of ["text", "delta", "output", "error"] as const) {
    const text = boundedText(source[key]);
    if (text !== undefined) result[key] = text;
  }
  const approval = safeApproval(source.approval);
  if (approval) result.approval = approval;
  return result;
}

function eventIsTerminal(event: SafeEvent): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.event);
}

function readSseFrame(frame: string): { id?: string; payload?: unknown } {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return { id };
  try {
    return { id, payload: JSON.parse(data.join("\n")) };
  } catch {
    return { id };
  }
}

export class HermesClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async runTask(input: RunTaskInput): Promise<RunAdmission> {
    const body: JsonRecord = { input: input.task };
    if (input.sessionId !== undefined) body.session_id = input.sessionId;
    let response: Response;
    try {
      response = await this.request("/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": input.clientRequestId },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof HermesApiError && error.code === "network_error") {
        throw new HermesApiError("ambiguous_admission");
      }
      throw error;
    }
    let parsed: JsonRecord;
    try {
      parsed = record(await this.json(response));
    } catch {
      throw new HermesApiError("ambiguous_admission");
    }
    if (
      typeof parsed.run_id !== "string" || parsed.run_id.length === 0
      || typeof parsed.status !== "string" || parsed.status.length === 0
      || typeof parsed.replayed !== "boolean"
    ) {
      throw new HermesApiError("ambiguous_admission");
    }
    return {
      run_id: parsed.run_id.slice(0, MAX_TEXT_LENGTH),
      status: parsed.status.slice(0, MAX_TEXT_LENGTH),
      replayed: parsed.replayed,
    };
  }

  async getStatus(runId: string): Promise<RunStatus> {
    return safeStatus(await this.json(await this.request(`/v1/runs/${encodeURIComponent(runId)}`)));
  }

  async stop(runId: string): Promise<Pick<RunStatus, "run_id" | "status">> {
    const status = safeStatus(await this.json(await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" })));
    return { run_id: status.run_id, status: status.status };
  }

  async getEvents(runId: string, afterSeq?: number, waitMs = 1_000): Promise<EventsResult> {
    const controller = new AbortController();
    const duration = Math.max(0, Math.min(MAX_WAIT_MS, waitMs));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, duration);
    const events: SafeEvent[] = [];
    let gapDetected = false;
    let terminal = false;
    let buffer = "";
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (afterSeq !== undefined) headers["last-event-id"] = String(afterSeq);
      const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, { headers, signal: controller.signal });
      if (!response.body) return { events, gap_detected: false, terminal: false };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (events.length < MAX_EVENTS && !terminal) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const decoded = readSseFrame(frame);
            const event = safeEvent(decoded.payload, decoded.id);
            if (!event) continue;
            events.push(event);
            gapDetected ||= event.event === "replay.truncated";
            terminal ||= eventIsTerminal(event);
            if (events.length >= MAX_EVENTS || terminal) break;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (!timedOut) throw error;
    } finally {
      clearTimeout(timer);
    }
    return { events, gap_detected: gapDetected, terminal };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        redirect: "error",
        headers: { authorization: `Bearer ${this.apiKey}`, ...init.headers },
      });
    } catch (error) {
      if (error instanceof HermesApiError) throw error;
      throw new HermesApiError("network_error");
    }
    if (!response.ok) throw new HermesApiError(response.status === 409 ? "upstream_conflict" : "upstream_error", response.status);
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new HermesApiError("upstream_error", response.status);
    }
  }
}
