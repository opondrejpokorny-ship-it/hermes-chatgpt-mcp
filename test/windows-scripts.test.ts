import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const windowsOnly = process.platform === "win32";
const scripts = join(process.cwd(), "scripts");
const fakeTunnelId = "tunnel_fake_test_123";
const fakeRuntimeKey = "fake-runtime-key-for-tests";

async function powershell(script: string, args: string[] = []) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-RuntimeApiKey") {
      index += 1;
      commandArgs.push("-RuntimeApiKey", "(ConvertTo-SecureString $env:HERMES_MCP_TEST_RUNTIME_KEY -AsPlainText -Force)");
    } else {
      commandArgs.push(args[index].startsWith("-") ? args[index] : quote(args[index]));
    }
  }
  return await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ${quote(join(scripts, script))} ${commandArgs.join(" ")}`], {
    windowsHide: true,
    env: { ...process.env, HERMES_MCP_TEST_RUNTIME_KEY: fakeRuntimeKey },
  });
}

async function startHealthServer(payload: object | ((url: string | undefined) => object)) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(typeof payload === "function" ? payload(request.url) : payload));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stop(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Windows runtime scripts keep test credentials out of config and task plans", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-test-"));
  try {
    const configured = await powershell("Set-HermesMcpTunnelConfig.ps1", [
      "-TunnelId", fakeTunnelId,
      "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`,
      "-StateRoot", stateRoot,
    ]);
    assert.deepEqual(JSON.parse(configured.stdout), { configured: true, alias: "hermes-mcp", profile: "hermes-mcp" });
    assert.doesNotMatch(await readFile(join(stateRoot, "config.json"), "utf8"), new RegExp(fakeRuntimeKey));
    const plan = await powershell("Register-HermesMcpRuntimeTask.ps1", ["-StateRoot", stateRoot, "-PlanOnly"]);
    assert.doesNotMatch(plan.stdout, new RegExp(fakeTunnelId));
    assert.doesNotMatch(plan.stdout, new RegExp(fakeRuntimeKey));
    assert.equal(JSON.parse(plan.stdout).plan_only, true);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows tunnel configuration rejects unsafe launch arguments", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-validation-"));
  const base = ["-TunnelId", fakeTunnelId, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-StateRoot", stateRoot];
  try {
    for (const invalid of [
      ["-Alias", 'safe" --runtime-api-key leaked'],
      ["-Profile", "profile; connect"],
      ["-TunnelClientPath", 'C:\\Tools\\client" --json.ps1'],
      ["-AdapterUrl", "http://user@127.0.0.1:8787"],
      ["-GatewayUrl", "http://127.0.0.1:8642/health"],
    ]) {
      await assert.rejects(powershell("Set-HermesMcpTunnelConfig.ps1", [...base, ...invalid]));
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows health output allowlists tunnel runtime status fields", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-health-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "ready" }));
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `@{ process_running = $true; healthy = $true; ready = $true; control_plane_poll_health = @{ state = 'unhealthy'; route = '/internal/control-plane/poll'; last_check = '2026-10-03T10:00:00Z'; history = @('forbidden') }; secret = 'forbidden'; tunnel_id = 'forbidden'; command = 'forbidden'; log_tail = 'forbidden' } | ConvertTo-Json -Depth 4 -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", [
      "-TunnelId", fakeTunnelId,
      "-TunnelClientPath", fakeTunnel,
      "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`,
      "-GatewayUrl", gateway.url,
      "-AdapterUrl", adapter.url,
      "-StateRoot", stateRoot,
    ]);
    const result = await powershell("Get-HermesMcpHealth.ps1", ["-StateRoot", stateRoot]);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema_version: 1,
      overall: "ready",
      gateway: { reachable: true },
      adapter: { healthy: true, ready: true },
      tunnel: { alias: "hermes-mcp", process_running: true, healthy: true, ready: true, control_plane_poll_health: "unhealthy" },
    });
    await writeFile(fakeTunnel, `@{ process_running = $true; healthy = $true; ready = $true; control_plane_poll_health = @{ state = 'unexpected'; route = '/internal/control-plane/poll'; history = @('forbidden') } } | ConvertTo-Json -Depth 4 -Compress`);
    const unknownResult = await powershell("Get-HermesMcpHealth.ps1", ["-StateRoot", stateRoot]);
    assert.equal(JSON.parse(unknownResult.stdout).tunnel.control_plane_poll_health, "unknown");
    await writeFile(fakeTunnel, `@{ process_running = $true; healthy = $true; ready = $true } | ConvertTo-Json -Compress`);
    const missingResult = await powershell("Get-HermesMcpHealth.ps1", ["-StateRoot", stateRoot]);
    assert.equal(JSON.parse(missingResult.stdout).tunnel.control_plane_poll_health, "unknown");
  } finally {
    await stop(gateway.server);
    await stop(adapter.server);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows supervisor direct file invocation resolves its default adapter path after binding", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-runtime-default-adapter-"));
  try {
    await assert.rejects(
      execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scripts, "Start-HermesMcpRuntime.ps1"), "-StateRoot", stateRoot, "-Once"], { windowsHide: true }),
      (error: { code?: number; stdout?: string; stderr?: string }) => {
        assert.equal(error.code, 2, error.stderr);
        assert.deepEqual(JSON.parse(error.stdout ?? ""), { overall: "degraded" });
        assert.doesNotMatch(error.stderr ?? "", /Split-Path|PSScriptRoot/i);
        return true;
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows supervisor once mode does not invoke tunnel status or connect before adapter readiness", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-unready-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "not_ready" }));
  const marker = join(stateRoot, "tunnel-invocation.txt");
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value ($args -join ' ') -Encoding UTF8; @{ process_running = $false; healthy = $false; ready = $false } | ConvertTo-Json -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", [
      "-TunnelId", fakeTunnelId,
      "-TunnelClientPath", fakeTunnel,
      "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`,
      "-GatewayUrl", gateway.url,
      "-AdapterUrl", adapter.url,
      "-StateRoot", stateRoot,
    ]);
    await assert.rejects(
      powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-Once"]),
      (error: { stdout?: string; code?: number }) => {
        assert.notEqual(error.code, 0);
        assert.deepEqual(JSON.parse(error.stdout ?? ""), { overall: "degraded" });
        return true;
      },
    );
    await assert.rejects(readFile(marker, "utf8"));
  } finally {
    await stop(gateway.server);
    await stop(adapter.server);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows direct health gates local readiness before decrypting or invoking tunnel status", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-health-gate-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "not_ready" }));
  const marker = join(stateRoot, "tunnel-status-invoked.txt");
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value invoked -Encoding UTF8; @{ process_running = $true; healthy = $true; ready = $true } | ConvertTo-Json -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", ["-TunnelId", fakeTunnelId, "-TunnelClientPath", fakeTunnel, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-GatewayUrl", gateway.url, "-AdapterUrl", adapter.url, "-StateRoot", stateRoot]);
    await assert.rejects(powershell("Get-HermesMcpHealth.ps1", ["-StateRoot", stateRoot]), (error: { stdout?: string; code?: number }) => {
      assert.equal(error.code, 2, JSON.stringify(error));
      assert.deepEqual(JSON.parse(error.stdout ?? ""), {
        schema_version: 1, overall: "degraded", gateway: { reachable: true }, adapter: { healthy: true, ready: false },
        tunnel: { alias: "hermes-mcp", process_running: false, healthy: false, ready: false, control_plane_poll_health: "unknown" },
      });
      return true;
    });
    await assert.rejects(readFile(marker, "utf8"));
  } finally {
    await stop(gateway.server); await stop(adapter.server); await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows tunnel child timeouts return bounded sanitized degraded results", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-timeout-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "ready" }));
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, "Start-Sleep -Seconds 8; @{ process_running = $true; healthy = $true; ready = $true } | ConvertTo-Json -Compress");
    await powershell("Set-HermesMcpTunnelConfig.ps1", ["-TunnelId", fakeTunnelId, "-TunnelClientPath", fakeTunnel, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-GatewayUrl", gateway.url, "-AdapterUrl", adapter.url, "-StateRoot", stateRoot]);
    const started = Date.now();
    await assert.rejects(powershell("Get-HermesMcpHealth.ps1", ["-StateRoot", stateRoot, "-TunnelTimeoutSeconds", "1"]), (error: { stdout?: string; code?: number }) => {
      assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout ?? "").overall, "degraded"); return true;
    });
    assert.ok(Date.now() - started < 6000, "timed-out status must not wait for child completion");
  } finally {
    await stop(gateway.server); await stop(adapter.server); await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows supervisor waits for delayed tunnel readiness without reconnecting", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-delayed-ready-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "ready" }));
  const marker = join(stateRoot, "tunnel-count.txt");
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `if ($args[1] -eq 'connect') { Add-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value connect; exit 1 }; $count = if (Test-Path -LiteralPath '${marker.replaceAll("'", "''")}') { (Get-Content -LiteralPath '${marker.replaceAll("'", "''")}').Count } else { 0 }; if ($count -gt 0) { Add-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value status }; @{ process_running = ($count -gt 0); healthy = ($count -gt 0); ready = ($count -ge 2) } | ConvertTo-Json -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", ["-TunnelId", fakeTunnelId, "-TunnelClientPath", fakeTunnel, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-GatewayUrl", gateway.url, "-AdapterUrl", adapter.url, "-StateRoot", stateRoot]);
    const result = await powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-Once", "-TunnelTimeoutSeconds", "2", "-TunnelReadyWaitSeconds", "6", "-HealthPollMilliseconds", "50"]);
    assert.deepEqual(JSON.parse(result.stdout), { overall: "ready" });
    assert.equal((await readFile(marker, "utf8")).trim().split(/\r?\n/).filter((line) => line === "connect").length, 1);
  } finally {
    await stop(gateway.server); await stop(adapter.server); await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows supervisor does not connect while an existing tunnel process is starting", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-already-starting-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "ready" }));
  const marker = join(stateRoot, "tunnel-connect.txt");
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `if ($args[1] -eq 'connect') { Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value connect }; @{ process_running = $true; healthy = $true; ready = $false } | ConvertTo-Json -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", ["-TunnelId", fakeTunnelId, "-TunnelClientPath", fakeTunnel, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-GatewayUrl", gateway.url, "-AdapterUrl", adapter.url, "-StateRoot", stateRoot]);
    await assert.rejects(powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-Once", "-TunnelReadyWaitSeconds", "1", "-HealthPollMilliseconds", "50"]), (error: { stdout?: string; code?: number }) => {
      assert.equal(error.code, 2); assert.deepEqual(JSON.parse(error.stdout ?? ""), { overall: "degraded" }); return true;
    });
    await assert.rejects(readFile(marker, "utf8"));
  } finally {
    await stop(gateway.server); await stop(adapter.server); await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows supervisor once mode connects only after local health gates pass", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-supervisor-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "ready" }));
  const marker = join(stateRoot, "tunnel-invocation.json");
  const errorMarker = join(stateRoot, "tunnel-error.txt");
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `trap { $_ | Set-Content -LiteralPath '${errorMarker.replaceAll("'", "''")}' -Encoding UTF8; exit 1 }\nif ($args[1] -eq 'connect') { $count = if (Test-Path -LiteralPath '${marker.replaceAll("'", "''")}') { ((Get-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Raw | ConvertFrom-Json).connect_count + 1) } else { 1 }; @{ argv = $args; runtime_key_present = -not [string]::IsNullOrEmpty($env:CONTROL_PLANE_API_KEY); connect_count = $count } | ConvertTo-Json -Compress | Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Encoding UTF8 }\nif (Test-Path -LiteralPath '${marker.replaceAll("'", "''")}') { $status = @{ process_running = $true; healthy = $true; ready = $true } } else { $status = @{ process_running = $false; healthy = $false; ready = $false } }; $status | ConvertTo-Json -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", [
      "-TunnelId", fakeTunnelId,
      "-TunnelClientPath", fakeTunnel,
      "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`,
      "-GatewayUrl", gateway.url,
      "-AdapterUrl", adapter.url,
      "-StateRoot", stateRoot,
    ]);
    let result;
    try {
      result = await powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-Once"]);
    } catch (error) {
      const childError = await readFile(errorMarker, "utf8").catch(() => "no fake tunnel error captured");
      throw new Error(`${String(error)}\nFake tunnel error: ${childError}`);
    }
    assert.deepEqual(JSON.parse(result.stdout), { overall: "ready" });
    const secondResult = await powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-Once"]);
    assert.deepEqual(JSON.parse(secondResult.stdout), { overall: "ready" });
    const invocation = JSON.parse((await readFile(marker, "utf8")).replace(/^\uFEFF/, "")) as { argv: string[]; runtime_key_present: boolean; connect_count: number };
    const argv = invocation.argv.join(" ");
    assert.match(argv, /--runtime-api-key/);
    assert.match(argv, /env:CONTROL_PLANE_API_KEY/);
    assert.doesNotMatch(argv, new RegExp(fakeRuntimeKey));
    assert.equal(invocation.runtime_key_present, true);
    assert.equal(invocation.connect_count, 1);
  } finally {
    await stop(gateway.server);
    await stop(adapter.server);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows daemon supervisor continues to a healthy second cycle after a sanitized tunnel failure", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-daemon-retry-"));
  const gateway = await startHealthServer({ status: "ok" });
  const adapter = await startHealthServer((url) => ({ status: url === "/healthz" ? "ok" : "ready" }));
  const marker = join(stateRoot, "tunnel-cycles.txt");
  const fakeTunnel = join(stateRoot, "fake-tunnel.ps1");
  try {
    await writeFile(fakeTunnel, `if ($args[1] -eq 'connect') { Add-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value connect; exit 0 }; Add-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value status; $statuses = (Get-Content -LiteralPath '${marker.replaceAll("'", "''")}' | Where-Object { $_ -eq 'status' }).Count; if ($statuses -le 2) { exit 1 }; @{ process_running = $true; healthy = $true; ready = $true } | ConvertTo-Json -Compress`);
    await powershell("Set-HermesMcpTunnelConfig.ps1", ["-TunnelId", fakeTunnelId, "-TunnelClientPath", fakeTunnel, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-GatewayUrl", gateway.url, "-AdapterUrl", adapter.url, "-StateRoot", stateRoot]);
    const result = await powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-MaxCycles", "2", "-RetrySeconds", "1", "-TunnelReadyWaitSeconds", "1", "-HealthPollMilliseconds", "50"]);
    assert.equal(result.stdout, "");
    const activity = await readFile(marker, "utf8");
    assert.ok(activity.split(/\r?\n/).filter((line) => line === "status").length >= 3, "the second cycle must reach tunnel status after the first sanitized failure");
  } finally {
    await stop(gateway.server); await stop(adapter.server); await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Windows supervisor does not launch a duplicate adapter for a live owned-process marker", { skip: !windowsOnly }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hermes-mcp-owned-adapter-"));
  const hermesRoot = join(stateRoot, "hermes");
  const launchMarker = join(stateRoot, "adapter-launched.txt");
  const adapterEntry = join(stateRoot, "fake-adapter.js");
  const gateway = await startHealthServer({ status: "ok" });
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], { windowsHide: true });
  try {
    assert.ok(child.pid);
    await mkdir(join(stateRoot, "processes"), { recursive: true });
    await mkdir(hermesRoot, { recursive: true });
    await writeFile(join(hermesRoot, ".env"), "API_SERVER_KEY=fake-adapter-key-for-tests\n");
    await writeFile(adapterEntry, `require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched'); setInterval(() => {}, 1000);`);
    const identity = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `$p = Get-Process -Id ${child.pid} -ErrorAction Stop; @{ pid = $p.Id; start_time_ticks = $p.StartTime.ToUniversalTime().Ticks; executable_path = $p.MainModule.FileName } | ConvertTo-Json -Compress`], { windowsHide: true });
    await writeFile(join(stateRoot, "processes", "adapter.json"), identity.stdout);
    await powershell("Set-HermesMcpTunnelConfig.ps1", ["-TunnelId", fakeTunnelId, "-RuntimeApiKey", `(ConvertTo-SecureString '${fakeRuntimeKey}' -AsPlainText -Force)`, "-GatewayUrl", gateway.url, "-AdapterUrl", "http://127.0.0.1:65530", "-StateRoot", stateRoot]);
    await assert.rejects(powershell("Start-HermesMcpRuntime.ps1", ["-StateRoot", stateRoot, "-Once", "-HermesRoot", hermesRoot, "-AdapterEntryPath", adapterEntry, "-AdapterReadyWaitSeconds", "1", "-HealthPollMilliseconds", "50"]));
    await assert.rejects(readFile(launchMarker, "utf8"));
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await stop(gateway.server); await rm(stateRoot, { recursive: true, force: true });
  }
});
