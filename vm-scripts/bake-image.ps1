<#
.SYNOPSIS
  Strips instance-specific state so this disk can become a reusable image.

.DESCRIPTION
  Run on a VM that provision.ps1 has taken all the way to streaming, and that
  you have verified actually streams. Afterwards, stop the instance and create
  an image from its disk.

  What the image keeps - the slow half, about twenty-five minutes:
    Git, the cloned repo including the host binary, the GRID/vWS driver in WDDM
    mode, and the MTT virtual display device.

  What it must not keep - anything naming one instance:
    the room secret in three places, the autologon password, the local account,
    the scheduled tasks bound to that account, and every log.

  The mechanism is provision.ps1's own stage marker. This script rewinds it to
  'account', so the first boot of an instance created from the image re-runs
  only the last two stages - create the local user with a freshly generated
  password, register the task graph, reboot into streaming. That is about two
  minutes instead of thirty, and each instance gets its own credentials rather
  than inheriting one baked into the image.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\glsplay\vm-scripts\bake-image.ps1

.NOTES
  This deliberately does NOT run GCESysprep. Sysprep /generalize tears down
  root-enumerated devices, and MttVDD is one - the virtual display would not
  survive, which is the single most tedious thing in the image to rebuild. The
  cost is that instances share a machine SID. That matters for Active Directory
  and some licensing; it does not matter for disposable, non-domain-joined,
  single-tenant gaming VMs. If you later need sysprep, rewind the stage marker
  to 'display' instead of 'account' so the VDD is recreated on first boot.
#>

[CmdletBinding()]
param(
  [string]$RepoRoot      = 'C:\glsplay',
  [string]$StateRoot     = 'C:\glsplay-provision',
  [string]$AutoLogonUser = 'glsplay',
  [string]$ResumeStage   = 'account',
  # Skips the confirmation. For scripted bakes.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script as Administrator.'
}

function Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "`n==> $m" -ForegroundColor Cyan }

if (-not $Force) {
  Write-Host ''
  Write-Host ' This strips the secret, the autologon account and the task graph' -ForegroundColor Yellow
  Write-Host ' from THIS VM. It will not stream again until it is reprovisioned' -ForegroundColor Yellow
  Write-Host ' or rebooted through the resumed stages.' -ForegroundColor Yellow
  Write-Host ''
  $answer = Read-Host ' Continue? (yes/no)'
  if ($answer -ne 'yes') { Write-Host ' aborted'; exit 1 }
}

# --- 1. verify there is something worth baking ------------------------------

Info 'Preflight'

$exe = Join-Path $RepoRoot 'apps\host\build\bin\Release\glsplay-host.exe'
if (Test-Path $exe) { Ok "host binary present" } else { Warn "host binary MISSING at $exe" }

$model = $null
try { $model = (& nvidia-smi --query-gpu=driver_model.current --format=csv,noheader) 2>$null } catch { }
if ($model -match 'WDDM') { Ok "driver $model" } else { Warn "driver is '$model', expected WDDM" }

$vdd = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
       Where-Object { $_.FriendlyName -match 'Virtual Display|MTT' }
if ($vdd) { Ok "virtual display: $($vdd.FriendlyName) [$($vdd.Status)]" }
else       { Warn 'no virtual display device - the image will not be able to capture' }

. (Join-Path $PSScriptRoot 'session-config.ps1')
$cfg = Get-GlsplaySessionConfig -RepoRoot $RepoRoot
if ($cfg.SignalingUrl -match '^wss?://(localhost|127\.0\.0\.1)') {
  Warn 'signaling url points at localhost - set glsplay-signaling-url to the central broker'
} else {
  Ok "signaling url $($cfg.SignalingUrl)"
}

# --- 2. stop everything -----------------------------------------------------

Info 'Stopping tasks'
foreach ($t in @('glsplay-host', 'glsplay-reclaim', 'glsplay-boot', 'glsplay-web', 'glsplay-signaling')) {
  $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    Ok "removed task $t"
  }
}
Get-Process -Name 'glsplay-host', 'node' -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Ok 'stopped host process'

# --- 3. secrets -------------------------------------------------------------

Info 'Removing secrets'

# The root .env carries the room secret. boot.ps1 rewrites it from metadata on
# every boot, which is what makes deleting it here safe as well as necessary.
# apps\web\.env is only present on images predating the central control plane;
# remove it if an older disk still has one.
foreach ($f in @((Join-Path $RepoRoot '.env'), (Join-Path $RepoRoot 'apps\web\.env'))) {
  if (Test-Path $f) { Remove-Item $f -Force; Ok "removed $f" }
}

[Environment]::SetEnvironmentVariable('GLSPLAY_ROOM_SECRET', $null, 'Machine')
Ok 'cleared machine GLSPLAY_ROOM_SECRET'

# Clear the autologon credentials both ways they can be stored: the registry
# values, and the LSA secret that Sysinternals Autologon writes instead. The
# account itself is removed below, so a surviving LSA secret would name a user
# that no longer exists - untidy rather than dangerous, but the whole point of
# this script is that nothing identifying one instance leaves on the disk.
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
foreach ($v in @('DefaultPassword', 'DefaultUserName', 'AutoAdminLogon')) {
  Remove-ItemProperty -Path $winlogon -Name $v -ErrorAction SilentlyContinue
}
Ok 'cleared autologon registry values'

$autologon = Join-Path $env:TEMP 'Autologon64.exe'
if (Test-Path $autologon) {
  & $autologon /accepteula /delete 2>&1 | Out-Null
  Ok 'cleared the autologon LSA secret'
} else {
  Warn 'Autologon64.exe not present - if the LSA secret was set, clear it with: Autologon64.exe /delete'
}

$user = Get-LocalUser -Name $AutoLogonUser -ErrorAction SilentlyContinue
if ($user) {
  Remove-LocalUser -Name $AutoLogonUser
  Ok "removed local user $AutoLogonUser"
  $profile = Join-Path $env:SystemDrive "Users\$AutoLogonUser"
  if (Test-Path $profile) {
    Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
    Ok 'removed its profile directory'
  }
}

# --- 4. logs and per-run state ----------------------------------------------

Info 'Removing logs'
$logs = @(
  (Join-Path $RepoRoot 'boot.log'), (Join-Path $RepoRoot 'boot.log.prev'),
  (Join-Path $RepoRoot 'host.log'), (Join-Path $RepoRoot 'host.log.prev'),
  (Join-Path $RepoRoot 'host.log.res'),
  (Join-Path $RepoRoot 'reclaim-console.log'),
  (Join-Path $StateRoot 'provision.log')
)
foreach ($f in $logs) { if (Test-Path $f) { Remove-Item $f -Force; Ok "removed $(Split-Path $f -Leaf)" } }

# --- 5. rewind the stage marker ---------------------------------------------

Info 'Rewinding provisioning state'
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
Set-Content -Path (Join-Path $StateRoot 'state.txt') -Value $ResumeStage -Encoding utf8
Ok "state.txt = $ResumeStage"
Write-Host "       first boot from the image re-runs from '$ResumeStage' onward" -ForegroundColor DarkGray

# --- 6. what to do next -----------------------------------------------------

$name = 'glsplay-' + (Get-Date -Format 'yyyyMMdd')
Write-Host ''
Write-Host '-----------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ' Ready to image. From your laptop:' -ForegroundColor White
Write-Host ''
Write-Host "   gcloud compute instances stop <instance> --zone=<zone>" -ForegroundColor Gray
Write-Host "   gcloud compute images create $name \" -ForegroundColor Gray
Write-Host "     --source-disk=<instance> --source-disk-zone=<zone> --family=glsplay" -ForegroundColor Gray
Write-Host ''
Write-Host ' Then every later instance is one command and about two minutes:' -ForegroundColor White
Write-Host ''
Write-Host '   gcloud compute instances create glsplay-2 --zone=<zone> \' -ForegroundColor Gray
Write-Host '     --machine-type=g2-standard-4 --image-family=glsplay \' -ForegroundColor Gray
Write-Host '     --enable-display-device \' -ForegroundColor Gray
Write-Host '     --metadata="glsplay-secret=$SECRET,glsplay-room=poc" \' -ForegroundColor Gray
Write-Host '     --metadata-from-file="windows-startup-script-ps1=vm-scripts/provision.ps1"' -ForegroundColor Gray
Write-Host ''
Write-Host ' The startup script is still required - it is what runs the' -ForegroundColor DarkGray
Write-Host ' resumed stages on first boot.' -ForegroundColor DarkGray
Write-Host '-----------------------------------------------------------' -ForegroundColor DarkGray
