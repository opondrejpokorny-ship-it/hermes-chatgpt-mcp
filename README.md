# Hermes ChatGPT MCP

Private-use integration project for connecting ChatGPT to a full Hermes Agent runtime through a thin MCP control adapter.

## Architecture

ChatGPT → `@Hermes` → Secure MCP Tunnel → this adapter → Hermes API server → full Hermes Agent.

The adapter does not duplicate Hermes' internal tool registry. Hermes remains responsible for its own tools, skills, memory, MCP connections, subagents and approvals.

## MVP tool surface

- `run_task` — admit a Hermes run with an explicit idempotency key.
- `get_status` — read a bounded, safe run-status projection.
- `get_events` — read a bounded replay window from Hermes SSE events.
- `stop` — request cooperative cancellation of a run.

The local Streamable HTTP MCP endpoint is `http://127.0.0.1:8787/mcp`.

## Security

- Hermes API remains localhost-only on the Cube runtime.
- The adapter itself binds only to `127.0.0.1` and rejects non-loopback Host headers.
- No API keys, tunnel credentials, tokens, passwords or cookies belong in this repository.
- `HERMES_API_KEY` is read only from the process environment.
- `HERMES_API_URL` defaults to `http://127.0.0.1:8642` and must stay loopback.
- Ambiguous `run_task` transport failures are never retried with a new idempotency key.
- Sensitive actions preserve Hermes approval semantics; approval tooling is a later milestone.

## Local development

Requires Node 24.19.0 or newer.

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```
