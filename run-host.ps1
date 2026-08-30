<#
.SYNOPSIS
  Launches glsplay-host with logging. Started by the glsplay-host task.

.DESCRIPTION
  Exists so the scheduled task can invoke a single file rather than a long
  quoted command line - schtasks mangles nested quotes, and debugging that is
  a worse use of time than keeping a small script around.

  Runs in the interactive console session, which Desktop Duplication requires.
  A service (session 0) has no desktop and cannot capture at all.

  Every value it needs comes from vm-scripts/session-config.ps1, which prefers
  GCE instance metadata. Nothing here is per-VM, so the same file works on any
  instance built from the image. Explicit parameters still win, for debugging.
#>

[CmdletBinding()]
param(
  [string]$RepoRoot = $PSScriptRoot,
  [string]$Room,
  [string]$SignalingUrl,
  [string]$Secret,
  # DXGI output to duplicate on the NVIDIA L4 adapter:
  #   0 = the L4's own phantom head (~1280x800)
  #   1 = the Virtual Display Driver monitor (1920x1080) <-- the one we want
  # host.log logs "DXGI adapters: [0] NVIDIA L4 outputs=2" - if that count or
  # ordering ever changes, revisit this.
  [string]$Output,
  [string]$LogLevel,
  [ValidateSet('on', 'off')][string]$Audio,
  [string]$LogPath
)

$ErrorActionPreference = 'Continue'
if (-not $LogPath) { $LogPath = Join-Path $RepoRoot 'host.log' }

. (Join-Path $RepoRoot 'vm-scripts\session-config.ps1')
$cfg = Get-GlsplaySessionConfig -RepoRoot $RepoRoot

if ($Room)         { $cfg.RoomId = $Room }
if ($SignalingUrl) { $cfg.SignalingUrl = $SignalingUrl }
if ($Secret)       { $cfg.Secret = $Secret }
if ($Output)       { $cfg.Output = $Output }
if ($LogLevel)     { $cfg.LogLevel = $LogLevel }
if ($Audio)        { $cfg.Audio = $Audio }

Set-Location $RepoRoot

# Pin the MTT virtual display to a fixed mode before capture starts. A wrong or
# changing resolution makes NVENC reject the live ReconfigureEncoder call.
& powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'vdd\set-vdd-res.ps1') -Width 1920 -Height 1080 -Hz 60 2>&1 |
  Out-File "$LogPath.res" -Encoding utf8
Start-Sleep -Seconds 2

$exe = Join-Path $RepoRoot 'apps\host\build\bin\Release\glsplay-host.exe'
if (-not (Test-Path $exe)) {
  "glsplay-host.exe not found at $exe" | Out-File $LogPath -Encoding utf8
  exit 1
}
if (-not $cfg.Secret) {
  "no room secret in metadata, environment or .env - refusing to start" | Out-File $LogPath -Encoding utf8
  exit 1
}

# Keep the previous run for comparison - the interesting failure is usually
# the one before the restart.
if (Test-Path $LogPath) {
  Move-Item $LogPath "$LogPath.prev" -Force -ErrorAction SilentlyContinue
}

# The secret goes through the environment rather than the command line so it
# does not show up in Task Manager or an audit log for every passer-by.
$env:GLSPLAY_ROOM_SECRET = $cfg.Secret

$hostArgs = @(
  '--room', $cfg.RoomId
  '--signaling-url', $cfg.SignalingUrl
  '--log-level', $cfg.LogLevel
)
if ($cfg.Audio -ne 'on')            { $hostArgs += '--no-audio' }
if ($cfg.Output -ne '')             { $hostArgs += @('--output', $cfg.Output) }

"$(Get-Date -Format o)  launching: $exe $($hostArgs -join ' ')" | Out-File $LogPath -Encoding utf8
& $exe @hostArgs *>> $LogPath
