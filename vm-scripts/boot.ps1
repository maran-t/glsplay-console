<#
.SYNOPSIS
  Boot-time config refresh. Runs as SYSTEM from the glsplay-boot task.

.DESCRIPTION
  The one thing that must happen on every boot before anything else starts:
  pull this instance's session config out of GCE metadata and publish it where
  the three processes can see it.

    * machine environment variables - inherited by every task started after
    * apps/web/.env                  - read by "next start" at runtime

  Then start the broker and the web app, in that order. They are registered
  without their own triggers precisely so this script owns the ordering;
  two "At startup" tasks have no defined sequence relative to each other, and
  the web app reading a stale .env because it won the race is the kind of bug
  that looks like a caching problem for a day.

  glsplay-host is NOT started here. It has to run in the interactive console
  session, so it hangs off the autologon logon trigger instead.
#>

[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$LogPath
)

$ErrorActionPreference = 'Continue'
if (-not $LogPath) { $LogPath = Join-Path $RepoRoot 'boot.log' }

function Log {
  param([string]$Message)
  "$(Get-Date -Format o)  $Message" | Out-File $LogPath -Append -Encoding utf8
}

if (Test-Path $LogPath) { Move-Item $LogPath "$LogPath.prev" -Force -ErrorAction SilentlyContinue }
Log "boot starting, repo=$RepoRoot"

. (Join-Path $PSScriptRoot 'session-config.ps1')
$cfg = Get-GlsplaySessionConfig -RepoRoot $RepoRoot

Log ("config: onGce={0} instance={1} zone={2} externalIp={3}" -f $cfg.OnGce, $cfg.InstanceName, $cfg.Zone, $cfg.ExternalIp)
Log ("        room={0} signaling={1} public={2} output={3} audio={4}" -f $cfg.RoomId, $cfg.SignalingUrl, $cfg.PublicSignalingUrl, $cfg.Output, $cfg.Audio)
Log ("        secret={0} chars" -f $cfg.Secret.Length)

if (-not $cfg.Secret) {
  Log 'FATAL: no room secret in metadata, environment or .env - broker will refuse to start'
}

# --- publish to the machine environment ------------------------------------

$machine = [ordered]@{
  GLSPLAY_ROOM_SECRET   = $cfg.Secret
  GLSPLAY_ROOM_ID       = $cfg.RoomId
  GLSPLAY_SIGNALING_URL = $cfg.SignalingUrl
  GLSPLAY_SIGNALING_HOST = '0.0.0.0'
  GLSPLAY_SIGNALING_PORT = '8080'
}
foreach ($key in $machine.Keys) {
  [Environment]::SetEnvironmentVariable($key, $machine[$key], 'Machine')
  # Also into this process, so the tasks started below inherit it now rather
  # than at the next boot.
  [Environment]::SetEnvironmentVariable($key, $machine[$key], 'Process')
}
Log "machine env set: $($machine.Keys -join ', ')"

# Both files, every boot. The broker's start script is
# `node --env-file=../../.env`, and Node exits outright if that file is missing
# - so a bake that deletes it (correctly, to avoid shipping a stale secret)
# depends on this line to put it back before the task starts.
$rootEnv = Write-GlsplayRootEnv -Config $cfg
Log "wrote $rootEnv"

$webEnv = Write-GlsplayWebEnv -Config $cfg
Log "wrote $webEnv"

# --- start the services, in order -------------------------------------------

foreach ($task in @('glsplay-signaling', 'glsplay-web')) {
  try {
    Start-ScheduledTask -TaskName $task -ErrorAction Stop
    Log "started task $task"
  } catch {
    Log "FAILED to start ${task}: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
}

# --- wait for the broker, so the host's logon trigger has something to dial --

$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod 'http://localhost:8080/health' -TimeoutSec 3 -ErrorAction Stop
    Log "broker healthy: status=$($health.status) rooms=$($health.rooms) peers=$($health.peers)"
    $healthy = $true
    break
  } catch {
    Start-Sleep -Seconds 3
  }
}
if (-not $healthy) { Log 'WARNING: broker did not answer /health within 90s' }

Log 'boot complete'
