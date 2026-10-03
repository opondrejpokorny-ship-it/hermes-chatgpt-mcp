[CmdletBinding()]
param(
  [string] $StateRoot = (Join-Path $env:LOCALAPPDATA 'HermesMcp'),
  [ValidateRange(1, 120)][int] $TunnelTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
function Assert-RuntimeConfig($config) {
  if ([string]$config.tunnel_id -notmatch '^tunnel_[A-Za-z0-9_-]{6,}$') { throw 'Invalid tunnel ID.' }
  foreach ($name in @('alias', 'profile')) { if ([string]$config.$name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "Invalid $name." } }
  $path = [string]$config.tunnel_client_path
  if ([string]::IsNullOrWhiteSpace($path) -or -not [IO.Path]::IsPathRooted($path) -or $path.IndexOfAny([char[]]"`"`r`n") -ge 0 -or [IO.Path]::GetExtension($path) -notin @('.exe', '.ps1')) { throw 'Invalid tunnel client path.' }
  foreach ($name in @('adapter_url', 'gateway_url')) { $url = [uri]$config.$name; $ip = $null; if ($url.Scheme -notin @('http', 'https') -or -not [Net.IPAddress]::TryParse($url.Host, [ref]$ip) -or -not [Net.IPAddress]::IsLoopback($ip) -or -not [string]::IsNullOrEmpty($url.UserInfo) -or $url.AbsolutePath -ne '/' -or -not [string]::IsNullOrEmpty($url.Query) -or -not [string]::IsNullOrEmpty($url.Fragment)) { throw "Invalid $name." } }
}
function Test-JsonHealth([string] $Url, [string] $Wanted) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -MaximumRedirection 0 -TimeoutSec 2; return (($response.StatusCode -eq 200) -and (($response.Content | ConvertFrom-Json).status -eq $Wanted)) } catch { return $false } }
function Get-AllowedStatus($Status) { $source = $Status; foreach ($name in @('runtime', 'local_runtime', 'localRuntime')) { if ($source.PSObject.Properties.Name -contains $name) { $source = $source.$name; break } }; [ordered]@{ process_running = [bool]$source.process_running; healthy = [bool]$source.healthy; ready = [bool]$source.ready; control_plane_poll_health = if (($source.PSObject.Properties.Name -contains 'control_plane_poll_health') -and ($source.control_plane_poll_health.PSObject.Properties.Name -contains 'state') -and ([string]$source.control_plane_poll_health.state -in @('healthy', 'unhealthy', 'unknown'))) { [string]$source.control_plane_poll_health.state } else { 'unknown' } } }
function Invoke-TunnelStatus($config, [string] $runtimeKey) {
  $arguments = "runtimes status `"$($config.alias)`" --json"; $info = [Diagnostics.ProcessStartInfo]::new(); $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  if ([IO.Path]::GetExtension([string]$config.tunnel_client_path) -ieq '.ps1') { $info.FileName = 'powershell.exe'; $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($config.tunnel_client_path)`" $arguments" } else { $info.FileName = $config.tunnel_client_path; $info.Arguments = $arguments }; $info.Environment['CONTROL_PLANE_API_KEY'] = $runtimeKey
  $process = [Diagnostics.Process]::Start($info)
  try { $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync(); if (-not $process.WaitForExit($TunnelTimeoutSeconds * 1000)) { try { $process.Kill() } catch {}; $process.WaitForExit(2000) | Out-Null; throw 'Tunnel status timed out.' }; $output = $stdout.GetAwaiter().GetResult(); $stderr.GetAwaiter().GetResult() | Out-Null; if ($process.ExitCode -ne 0) { throw 'Tunnel status failed.' }; return $output } finally { $process.Dispose() }
}
function Write-Result($alias, [bool]$gateway, [bool]$adapterHealthy, [bool]$adapterReady, $tunnel, [string]$overall, [int]$code) { [ordered]@{ schema_version = 1; overall = $overall; gateway = @{ reachable = $gateway }; adapter = @{ healthy = $adapterHealthy; ready = $adapterReady }; tunnel = @{ alias = $alias; process_running = [bool]$tunnel.process_running; healthy = [bool]$tunnel.healthy; ready = [bool]$tunnel.ready; control_plane_poll_health = [string]$tunnel.control_plane_poll_health } } | ConvertTo-Json -Compress; [Environment]::Exit($code) }
$emptyTunnel = [ordered]@{ process_running = $false; healthy = $false; ready = $false; control_plane_poll_health = 'unknown' }
try { $config = Get-Content -LiteralPath (Join-Path $StateRoot 'config.json') -Raw | ConvertFrom-Json; Assert-RuntimeConfig $config } catch { Write-Result 'unknown' $false $false $false $emptyTunnel 'down' 1 }
$gateway = Test-JsonHealth (([uri]$config.gateway_url).GetLeftPart([System.UriPartial]::Authority) + '/health') 'ok'; $adapterHealthy = Test-JsonHealth (([uri]$config.adapter_url).GetLeftPart([System.UriPartial]::Authority) + '/healthz') 'ok'; $adapterReady = Test-JsonHealth (([uri]$config.adapter_url).GetLeftPart([System.UriPartial]::Authority) + '/readyz') 'ready'
if (-not ($gateway -and $adapterHealthy -and $adapterReady)) { Write-Result ([string]$config.alias) $gateway $adapterHealthy $adapterReady $emptyTunnel 'degraded' 2 }
try { $secret = (Get-Content -LiteralPath (Join-Path $StateRoot 'secrets\control-plane-api-key.dpapi') -Raw).Trim() | ConvertTo-SecureString; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret); try { $runtimeKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }; try { $tunnel = Get-AllowedStatus ((Invoke-TunnelStatus $config $runtimeKey) | ConvertFrom-Json) } finally { Remove-Variable runtimeKey -ErrorAction SilentlyContinue } } catch { Write-Result ([string]$config.alias) $gateway $adapterHealthy $adapterReady $emptyTunnel 'degraded' 2 }
$overall = if ($tunnel.process_running -and $tunnel.healthy -and $tunnel.ready) { 'ready' } else { 'degraded' }; Write-Result ([string]$config.alias) $gateway $adapterHealthy $adapterReady $tunnel $overall $(if ($overall -eq 'ready') { 0 } else { 2 })
