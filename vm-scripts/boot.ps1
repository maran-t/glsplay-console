<#
.SYNOPSIS
  Boot-time config refresh. Runs as SYSTEM from the glsplay-boot task.

.DESCRIPTION
  The one thing that must happen on every boot before anything else starts:
  pull this instance's session config out of GCE metadata and publish it where
  the host can see it.

    * machine environment variables - inherited by every task started after
    * the repo-root .env            - the fallback beneath those

  Then check that the central broker answers, so an unreachable or mistyped
  signaling URL shows up here rather than as a connect failure buried in
  host.log twenty minutes later.

  Nothing is started here. The broker and the web client are one central
  deployment that this VM dials out to; glsplay-host does that itself, from the
  interactive console session, off the autologon logon trigger - a service in
  session 0 has no desktop and could not capture at all.
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

# The root .env, every boot. The host reads it as a fallback beneath the
# machine environment, and a bake correctly deletes it so no secret ships inside
# the image - so writing it back here is what makes that deletion safe.
#
# apps\web\.env is no longer written: the web client is not served from this VM.
$rootEnv = Write-GlsplayRootEnv -Config $cfg
Log "wrote $rootEnv"

# --- reachability of the central broker -------------------------------------

# Nothing is started here any more. The broker and the web client are one
# central deployment; this VM only dials out to them, and glsplay-host does that
# itself from the console session at logon.
#
# What is still worth doing at boot is failing loudly if the broker cannot be
# reached, because the alternative is discovering it inside host.log later.
if ($cfg.SignalingUrl -match '^wss?://(localhost|127\.0\.0\.1)') {
  Log 'FATAL: signaling url points at localhost, but nothing serves it on this VM'
  Log '       set instance metadata glsplay-signaling-url to the central broker'
} else {
  $probe = $cfg.SignalingUrl -replace '^ws', 'http'
  $deadline = (Get-Date).AddSeconds(60)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod "$probe/health" -TimeoutSec 5 -ErrorAction Stop
      Log "broker reachable: status=$($health.status) rooms=$($health.rooms) peers=$($health.peers)"
      $healthy = $true
      break
    } catch {
      Start-Sleep -Seconds 5
    }
  }
  # Not fatal. A proxy may route the WebSocket without exposing /health, which
  # is a configuration choice rather than a fault - the host will still connect.
  if (-not $healthy) {
    Log "WARNING: no /health from $probe within 60s"
    Log '         the WebSocket may still work; check host.log for the real answer'
  }
}

Log 'boot complete'
