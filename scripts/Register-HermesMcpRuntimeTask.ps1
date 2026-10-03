[CmdletBinding()]
param(
  [string] $StateRoot = (Join-Path $env:LOCALAPPDATA 'HermesMcp'),
  [string] $TaskName = 'Hermes ChatGPT MCP Runtime',
  [switch] $PlanOnly
)

$ErrorActionPreference = 'Stop'
$runtimeScript = Join-Path $PSScriptRoot 'Start-HermesMcpRuntime.ps1'
$action = "-NoProfile -ExecutionPolicy Bypass -File `"$runtimeScript`""
$plan = [ordered]@{ plan_only = [bool]$PlanOnly; task_name = $TaskName; trigger = 'AtLogOn'; run_level = 'Limited'; multiple_instances = 'IgnoreNew'; restart_count = 3; restart_interval_minutes = 1 }
if ($PlanOnly) { $plan | ConvertTo-Json -Compress; exit 0 }
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $action
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
[ordered]@{ registered = $true; task_name = $TaskName } | ConvertTo-Json -Compress
