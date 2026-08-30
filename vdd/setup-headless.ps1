<#
.SYNOPSIS
  Registers the glsplay task graph on this VM. Run once, at image-bake time.

.DESCRIPTION
  Self-elevates. Nothing it writes is per-instance: every value the running
  system needs comes from GCE metadata at boot, so an image baked after this
  script runs will stream on any instance created from it without being
  touched.

  The task graph:

    glsplay-boot        At startup        SYSTEM  vm-scripts\boot.ps1
                        -> instance metadata into the machine environment
                           and the root .env
    glsplay-host        At logon +delay   user    run-host.ps1
    glsplay-reclaim     RDP disconnect    SYSTEM  vdd\reclaim-console.ps1

  The broker and the web client used to run here too. They are now one central
  deployment behind TLS that every VM dials out to, so this machine runs a
  single native binary and needs no JS runtime at all.

  glsplay-host hangs off the logon trigger because Desktop Duplication can only
  capture the session that owns the display, and with autologon that session
  exists from boot. glsplay-reclaim is now the exception path, not the happy
  path: it only matters if a human RDPs in and then disconnects, which in
  production nobody does.

.EXAMPLE
  .\setup-headless.ps1
  .\setup-headless.ps1 -User someuser -HostStartDelaySec 60
#>

[CmdletBinding()]
param(
  # Defaults to the configured autologon user - the account that will own the
  # console session, which is the only one that can capture.
  [string]$User,
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$NpmPath,
  # Gives the VDD, the network and the broker time to come up before capture
  # starts. The host retries, but a clean first attempt keeps host.log readable.
  [int]$HostStartDelaySec = 45
)

# --- self-elevate (forwarding what we were given) ---------------------------
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $forward = @("-ExecutionPolicy Bypass -File `"$PSCommandPath`"")
  if ($User)    { $forward += "-User `"$User`"" }
  if ($RepoRoot){ $forward += "-RepoRoot `"$RepoRoot`"" }
  if ($NpmPath) { $forward += "-NpmPath `"$NpmPath`"" }
  $forward += "-HostStartDelaySec $HostStartDelaySec"
  Start-Process powershell.exe ($forward -join ' ') -Verb RunAs
  exit
}

$ErrorActionPreference = 'Stop'

function Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "`n==> $m" -ForegroundColor Cyan }

# --- 0. resolve what used to be hardcoded -----------------------------------

Info 'Resolving environment'

if (-not $User) {
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  $User = (Get-ItemProperty -Path $winlogon -Name 'DefaultUserName' -ErrorAction SilentlyContinue).DefaultUserName
  if ($User) {
    Ok "autologon user from the registry: $User"
  } else {
    $User = $env:USERNAME
    Warn "no autologon user configured; falling back to $User"
    Warn 'Run vm-scripts\setup-gcp-vm.ps1 with -AutoLogonUser and -AutoLogonPassword'
    Warn 'first, or the console session is empty after a reboot and nothing captures.'
  }
}

Ok "repo     $RepoRoot"
Ok "user     $User"

. (Join-Path $RepoRoot 'vm-scripts\session-config.ps1')
$cfg = Get-GlsplaySessionConfig -RepoRoot $RepoRoot
if ($cfg.OnGce) {
  Ok "metadata reachable (instance $($cfg.InstanceName), zone $($cfg.Zone))"
} else {
  Ok 'metadata not reachable - falling back to environment and .env'
}

# --- 1. room secret ---------------------------------------------------------

Info 'Room secret'
if ($cfg.Secret) {
  [Environment]::SetEnvironmentVariable('GLSPLAY_ROOM_SECRET', $cfg.Secret, 'Machine')
  Ok "GLSPLAY_ROOM_SECRET set for the machine ($($cfg.Secret.Length) chars)"
  if ($cfg.Secret.Length -ne 64) { Warn 'expected 64 chars from a 32-byte hex secret' }
} else {
  Warn 'No secret found. That is fine for an image bake - glsplay-boot reads it'
  Warn 'from instance metadata (glsplay-secret) on every boot.'
}

# --- 2. task helpers --------------------------------------------------------

$common = @{
  ExecutionTimeLimit         = [TimeSpan]::Zero
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  MultipleInstances          = 'IgnoreNew'
}

function Register-GlsplayTask {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)]$Action,
    $Trigger,
    [Parameter(Mandatory)]$Principal,
    $Settings
  )
  if (-not $Settings) { $Settings = New-ScheduledTaskSettingsSet @common }
  $params = @{
    TaskName  = $Name
    Action    = $Action
    Principal = $Principal
    Settings  = $Settings
    Force     = $true
  }
  if ($Trigger) { $params['Trigger'] = $Trigger }
  Register-ScheduledTask @params | Out-Null
  Ok "task '$Name'"
}

function New-PsAction {
  param([string]$File, [string]$Arguments = '')
  New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-ExecutionPolicy Bypass -NonInteractive -File `"$File`" $Arguments").Trim()
}

$systemPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
  -LogonType ServiceAccount -RunLevel Highest

# Interactive is the important bit: the task runs inside the logged-on desktop
# session. An S4U or ServiceAccount principal lands in session 0, which has no
# desktop, and Desktop Duplication then has nothing to duplicate.
$userPrincipal = New-ScheduledTaskPrincipal -UserId $User `
  -LogonType Interactive -RunLevel Highest

# --- 3. boot task -----------------------------------------------------------

Info 'Boot config task'
Register-GlsplayTask -Name 'glsplay-boot' `
  -Action (New-PsAction (Join-Path $RepoRoot 'vm-scripts\boot.ps1')) `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Principal $systemPrincipal

# --- 4. remove the old service tasks ----------------------------------------

# The broker and the web client used to run here, one copy per VM. They are now
# a single central deployment behind TLS, which this machine dials out to - so
# these tasks are not merely unused, they would bind ports and serve a stale
# config if an old image still carried them.
Info 'Removing superseded service tasks'
foreach ($stale in @('glsplay-signaling', 'glsplay-web')) {
  if (Get-ScheduledTask -TaskName $stale -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $stale -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $stale -Confirm:$false -ErrorAction SilentlyContinue
    Ok "removed $stale"
  }
}

# --- 5. host task -----------------------------------------------------------

Info 'Host task'
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$logonTrigger.Delay = "PT${HostStartDelaySec}S"

# Restart on failure. This is not a substitute for a supervisor service - it
# cannot relaunch across a session change, and nothing external can command it -
# but it covers the ordinary case of the host exiting, which otherwise waits
# for the next logon.
$hostSettings = New-ScheduledTaskSettingsSet @common `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3

Register-GlsplayTask -Name 'glsplay-host' `
  -Action (New-PsAction (Join-Path $RepoRoot 'run-host.ps1')) `
  -Trigger $logonTrigger -Principal $userPrincipal -Settings $hostSettings
Ok "starts $HostStartDelaySec seconds after $User logs on to the console"
Ok 'restarts up to 3 times, one minute apart, if it exits'

# --- 6. reclaim task (exception path) ---------------------------------------

Info 'Console reclaim (only needed after a human RDPs in)'
$disconnect = New-CimInstance -ClientOnly `
  -CimClass (Get-CimClass MSFT_TaskSessionStateChangeTrigger root/Microsoft/Windows/TaskScheduler) `
  -Property @{ StateChange = 4 }   # 4 = RemoteDisconnect
Register-GlsplayTask -Name 'glsplay-reclaim' `
  -Action (New-PsAction (Join-Path $RepoRoot 'vdd\reclaim-console.ps1')) `
  -Trigger $disconnect -Principal $systemPrincipal

# --- 7. lock / power hardening (idempotent) ---------------------------------

Info 'Lock / power'
$sys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Set-ItemProperty $sys PromptOnSecureDesktop  -Value 0 -Type DWord
Set-ItemProperty $sys InactivityTimeoutSecs  -Value 0 -Type DWord
Set-ItemProperty $sys DisableLockWorkstation -Value 1 -Type DWord
$per = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
New-Item $per -Force | Out-Null
Set-ItemProperty $per NoLockScreen -Value 1 -Type DWord
powercfg /change monitor-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-ac 0 | Out-Null
Ok 'secure desktop off, no auto-lock, no sleep'

# --- 8. status --------------------------------------------------------------

Info 'Status'
Get-ScheduledTask glsplay-* | Select-Object TaskName, State | Format-Table -AutoSize

if ($cfg.ExternalIp) { $browseAt = "http://$($cfg.ExternalIp):3000" }
else                 { $browseAt = 'http://<vm-external-ip>:3000' }

Write-Host ''
Write-Host '-----------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ' Registered. This machine is now image-bakeable.' -ForegroundColor White
Write-Host ''
Write-Host '   Bake:   gcloud compute instances stop <instance>' -ForegroundColor Gray
Write-Host '           gcloud compute images create glsplay-<date> --source-disk <disk>' -ForegroundColor Gray
Write-Host ''
Write-Host '   Launch: gcloud compute instances create <name> --image glsplay-<date> \' -ForegroundColor Gray
Write-Host '             --metadata glsplay-room=<room>,glsplay-secret=<secret>' -ForegroundColor Gray
Write-Host ''
Write-Host "   Play:   $browseAt" -ForegroundColor Gray
Write-Host ''
Write-Host '   Logs:   boot.log  host.log (+ .prev, .res)  reclaim-console.log' -ForegroundColor Gray
Write-Host '-----------------------------------------------------------' -ForegroundColor DarkGray
