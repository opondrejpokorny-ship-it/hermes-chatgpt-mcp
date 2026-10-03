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

## Milestone 2 runtime

The adapter stays local at `127.0.0.1:8787`; it exposes unauthenticated, loopback-only `GET /healthz` and `GET /readyz` checks in addition to `/mcp`. Hermes stays local at `127.0.0.1:8642`; readiness requires its `/health` response to be HTTP 200 with `{ "status": "ok" }`.

Windows supervision is hybrid: a CurrentUser AtLogOn Scheduled Task re-enters the local supervisor after sign-in, while the official OpenAI tunnel client manages the tunnel runtime through `runtimes connect` and `runtimes status`. The client is installed outside this repository at `C:\Tools\openai-tunnel-client\v0.0.15\tunnel-client.exe`; do not vendor it here.

All runtime state is machine-local under `%LOCALAPPDATA%\HermesMcp`: configuration, tunnel profile data, logs, and a DPAPI CurrentUser ciphertext for the runtime key. The tunnel ID is also local-only. The Hermes API key remains solely in `%LOCALAPPDATA%\hermes\.env`; the supervisor reads it only to launch the adapter child process. No persistent environment variables are created.

### Setup

First perform the unavoidable user actions:

- In the OpenAI Platform, create/select the tunnel and create a runtime key scoped to **Tunnels: Read + Use**.
- With the local runtime running, select the corresponding ChatGPT connector.

Then configure only on the Windows machine that will run the local runtime. Use placeholders; never place real values in this repository.

```powershell
$runtimeKey = Read-Host 'Runtime API key' -AsSecureString
.\scripts\Set-HermesMcpTunnelConfig.ps1 `
  -TunnelId 'tunnel_<local-placeholder>' `
  -RuntimeApiKey $runtimeKey
.\scripts\Register-HermesMcpRuntimeTask.ps1
```

For a manual local bootstrap without a daemon loop:

```powershell
.\scripts\Start-HermesMcpRuntime.ps1 -Once
.\scripts\Get-HermesMcpHealth.ps1
```

`-StateRoot` is available only for isolated tests or local development; production uses `%LOCALAPPDATA%\HermesMcp`. This milestone does not claim a real `run_task` end-to-end execution because Hermes currently has no inference provider connected.
