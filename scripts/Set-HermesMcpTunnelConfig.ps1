[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^tunnel_[A-Za-z0-9_-]{6,}$')] [string] $TunnelId,
  [securestring] $RuntimeApiKey,
  [string] $TunnelClientPath = 'C:\Tools\openai-tunnel-client\v0.0.15\tunnel-client.exe',
  [string] $Alias = 'hermes-mcp',
  [string] $Profile = 'hermes-mcp',
  [string] $AdapterUrl = 'http://127.0.0.1:8787',
  [string] $GatewayUrl = 'http://127.0.0.1:8642',
  [string] $StateRoot = (Join-Path $env:LOCALAPPDATA 'HermesMcp')
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StateRoot)) { throw 'StateRoot is required.' }
if ($Alias -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Alias must be a safe runtime name.' }
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Profile must be a safe runtime name.' }
if ([string]::IsNullOrWhiteSpace($TunnelClientPath) -or -not [IO.Path]::IsPathRooted($TunnelClientPath) -or $TunnelClientPath.IndexOfAny([char[]]"`"`r`n") -ge 0 -or [IO.Path]::GetExtension($TunnelClientPath) -notin @('.exe', '.ps1')) { throw 'Tunnel client path must be an absolute .exe or .ps1 path without quotes or control characters.' }
if (-not $RuntimeApiKey) { $RuntimeApiKey = Read-Host 'Runtime API key' -AsSecureString }
if ($RuntimeApiKey.Length -lt 1) { throw 'Runtime API key is required.' }
foreach ($url in @($AdapterUrl, $GatewayUrl)) {
  $parsed = [uri]$url
  $ip = $null
  if ($parsed.Scheme -notin @('http', 'https') -or -not [Net.IPAddress]::TryParse($parsed.Host, [ref]$ip) -or -not [Net.IPAddress]::IsLoopback($ip) -or -not [string]::IsNullOrEmpty($parsed.UserInfo) -or $parsed.AbsolutePath -ne '/' -or -not [string]::IsNullOrEmpty($parsed.Query) -or -not [string]::IsNullOrEmpty($parsed.Fragment)) { throw 'Adapter and gateway URLs must be root loopback HTTP URLs without credentials, query, or fragment.' }
}

$secretDir = Join-Path $StateRoot 'secrets'
$profileDir = Join-Path $StateRoot 'tunnel-profiles'
New-Item -ItemType Directory -Force -Path $StateRoot, $secretDir, $profileDir | Out-Null
try {
  $acl = Get-Acl -LiteralPath $StateRoot
  $acl.SetAccessRuleProtection($true, $true)
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -LiteralPath $StateRoot -AclObject $acl
} catch { }

$config = [ordered]@{
  schema_version = 1
  tunnel_id = $TunnelId
  tunnel_client_path = $TunnelClientPath
  profile = $Profile
  alias = $Alias
  adapter_url = $AdapterUrl
  gateway_url = $GatewayUrl
}
$config | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $StateRoot 'config.json') -Encoding UTF8
ConvertFrom-SecureString -SecureString $RuntimeApiKey | Set-Content -LiteralPath (Join-Path $secretDir 'control-plane-api-key.dpapi') -Encoding ascii
[ordered]@{ configured = $true; alias = $Alias; profile = $Profile } | ConvertTo-Json -Compress
