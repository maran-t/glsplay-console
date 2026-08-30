<#
.SYNOPSIS
  Resolves a glsplay session's config, preferring GCE instance metadata.

.DESCRIPTION
  Dot-source this file and call Get-GlsplaySessionConfig.

  Precedence, highest first:
    1. GCE instance metadata   instance/attributes/glsplay-*
    2. process, then machine, environment variables
    3. .env at the repo root
    4. built-in defaults

  Metadata is what makes a VM disposable. The control plane stamps room,
  secret and broker URL onto the instance at create time, so nothing baked
  into the image is per-VM and no file on disk needs editing to bring a new
  instance up. The env and .env layers exist so the same scripts still work
  on a workstation with no metadata server.

.EXAMPLE
  . .\session-config.ps1
  $cfg = Get-GlsplaySessionConfig

.EXAMPLE
  .\session-config.ps1 -Show
#>

[CmdletBinding()]
param([switch]$Show)

$script:MetadataReachable = $null
$script:MetadataBase = 'http://metadata.google.internal/computeMetadata/v1'

# One cheap probe, cached. Off GCE every lookup would otherwise pay a DNS
# failure, and run-host.ps1 makes about a dozen of them before launching.
function Test-GceMetadata {
  if ($null -ne $script:MetadataReachable) { return $script:MetadataReachable }
  try {
    $null = Invoke-RestMethod -Uri "$script:MetadataBase/instance/id" `
      -Headers @{ 'Metadata-Flavor' = 'Google' } -TimeoutSec 2 -ErrorAction Stop
    $script:MetadataReachable = $true
  } catch {
    $script:MetadataReachable = $false
  }
  return $script:MetadataReachable
}

function Get-GceMetadata {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-GceMetadata)) { return $null }
  try {
    # A missing attribute is a 404, which throws - that is the "not set" path,
    # not an error worth surfacing.
    $value = Invoke-RestMethod -Uri "$script:MetadataBase/$Path" `
      -Headers @{ 'Metadata-Flavor' = 'Google' } -TimeoutSec 5 -ErrorAction Stop
    $text = ([string]$value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text
  } catch {
    return $null
  }
}

function Get-DotEnvValue {
  param([string]$Path, [string]$Key)
  if (-not $Path -or -not (Test-Path $Path)) { return $null }
  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  $line = Get-Content $Path -ErrorAction SilentlyContinue |
          Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) { return $null }
  $value = ($line -replace $pattern, '').Trim()
  if ($value.Length -ge 2 -and
      (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value
}

function Resolve-GlsplaySetting {
  param(
    [string]$MetadataKey,
    [string]$EnvName,
    [string]$DotEnvPath,
    [string]$Default
  )
  if ($MetadataKey) {
    $value = Get-GceMetadata "instance/attributes/$MetadataKey"
    if ($value) { return $value }
  }
  if ($EnvName) {
    $value = [Environment]::GetEnvironmentVariable($EnvName, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
      $value = [Environment]::GetEnvironmentVariable($EnvName, 'Machine')
    }
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
    $value = Get-DotEnvValue -Path $DotEnvPath -Key $EnvName
    if ($value) { return $value }
  }
  return $Default
}

function Get-GlsplaySessionConfig {
  [CmdletBinding()]
  param([string]$RepoRoot)

  if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
  $dotEnv = Join-Path $RepoRoot '.env'

  $externalIp = Get-GceMetadata 'instance/network-interfaces/0/access-configs/0/external-ip'
  $zone = Get-GceMetadata 'instance/zone'
  if ($zone) { $zone = $zone.Split('/')[-1] }

  $signalingUrl = Resolve-GlsplaySetting 'glsplay-signaling-url' 'GLSPLAY_SIGNALING_URL' $dotEnv 'ws://localhost:8080'

  # What the browser is told to dial. On the VM the host talks to the broker
  # over loopback, but the browser cannot - so a public URL is derived from the
  # external IP unless one is stamped explicitly. Phase 2 replaces this with a
  # central wss:// broker and the derivation goes away.
  $publicSignalingUrl = Resolve-GlsplaySetting 'glsplay-public-signaling-url' 'GLSPLAY_PUBLIC_SIGNALING_URL' $dotEnv ''
  if (-not $publicSignalingUrl) {
    if ($signalingUrl -notmatch 'localhost|127\.0\.0\.1') {
      $publicSignalingUrl = $signalingUrl
    } elseif ($externalIp) {
      $publicSignalingUrl = "ws://${externalIp}:8080"
    } else {
      $publicSignalingUrl = $signalingUrl
    }
  }

  [pscustomobject][ordered]@{
    RepoRoot           = $RepoRoot
    OnGce              = (Test-GceMetadata)
    InstanceName       = Get-GceMetadata 'instance/name'
    Zone               = $zone
    ExternalIp         = $externalIp
    SignalingUrl       = $signalingUrl
    PublicSignalingUrl = $publicSignalingUrl
    RoomId             = Resolve-GlsplaySetting 'glsplay-room'      'GLSPLAY_ROOM_ID'     $dotEnv 'poc'
    Secret             = Resolve-GlsplaySetting 'glsplay-secret'    'GLSPLAY_ROOM_SECRET' $dotEnv ''
    Output             = Resolve-GlsplaySetting 'glsplay-output'    'GLSPLAY_OUTPUT'      $dotEnv '1'
    Audio              = Resolve-GlsplaySetting 'glsplay-audio'     'GLSPLAY_AUDIO'       $dotEnv 'off'
    LogLevel           = Resolve-GlsplaySetting 'glsplay-log-level' 'GLSPLAY_LOG_LEVEL'   $dotEnv 'debug'
  }
}

# Writes the file next build / next start reads. Next.js loads .env from the
# project directory, not the monorepo root, which is why this is a second file
# rather than a symlink to the root one.
function Write-GlsplayWebEnv {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Config)

  $path = Join-Path $Config.RepoRoot 'apps\web\.env'
  $lines = @(
    "# Generated at boot by vm-scripts/boot.ps1 - edits are overwritten.",
    "GLSPLAY_ROOM_SECRET=$($Config.Secret)",
    "GLSPLAY_SIGNALING_URL=$($Config.PublicSignalingUrl)",
    "GLSPLAY_ROOM_ID=$($Config.RoomId)",
    "NEXT_PUBLIC_SIGNALING_URL=$($Config.PublicSignalingUrl)",
    "NEXT_PUBLIC_ROOM_ID=$($Config.RoomId)",
    "NEXT_PUBLIC_ROOM_SECRET=$($Config.Secret)"
  )
  Set-Content -Path $path -Value $lines -Encoding utf8
  return $path
}

if ($Show) { Get-GlsplaySessionConfig | Format-List }
