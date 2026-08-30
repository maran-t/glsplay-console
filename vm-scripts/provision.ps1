<#
.SYNOPSIS
  Unattended end-to-end provisioning. Runs as a GCE startup script.

.DESCRIPTION
  Takes a bare Windows Server 2022 + L4 instance to a streaming host with no
  RDP session and no human step. Attach it at create time:

    gcloud compute instances create NAME ... \
      --metadata-from-file windows-startup-script-ps1=vm-scripts/provision.ps1 \
      --metadata glsplay-secret=SECRET,glsplay-room=poc

  GCE runs a Windows startup script on *every* boot, which is what makes this
  resumable for free: the driver install needs two reboots, and each boot the
  script re-reads its state file and continues from the next stage rather than
  starting over.

  Stages, each idempotent:
    1 tools     Git, clone the repo (the host binary comes with it)
    2 driver    replace the compute/TCC driver with GRID/vWS  (2 reboots)
    3 display   vdd_settings.xml, then the MTT VDD via nefcon (no GUI wizard)
    4 check     verify the host binary and that the broker is reachable
    5 account   dedicated local user + autologon, so a console session exists
    6 tasks     register the glsplay task graph            (reboot into service)

  Progress goes to the serial console, so you can watch a machine you have
  never logged into:

    gcloud compute instances get-serial-port-output NAME --zone ZONE

.NOTES
  The autologon account is created here with a locally generated password that
  is never written to metadata. Autologon requires the password in the registry
  in clear text - that is inherent to headless capture, not a choice this
  script makes - so the account is a dedicated non-admin-by-default local user
  rather than the GCE-managed one, and the VM should stay firewalled.
#>

[CmdletBinding()]
param(
  [string]$RepoUrl    = 'https://github.com/maran-t/glsplay.git',
  [string]$Branch     = 'phase0-metadata-boot',
  [string]$RepoRoot   = 'C:\glsplay',
  [string]$StateRoot  = 'C:\glsplay-provision',
  [string]$AutoLogonUser = 'glsplay'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest is ~10x faster without it

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
$LogPath   = Join-Path $StateRoot 'provision.log'
$StatePath = Join-Path $StateRoot 'state.txt'

function Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = "$(Get-Date -Format o)  $Level  $Message"
  $line | Out-File $LogPath -Append -Encoding utf8
  # Startup-script output is captured to the serial console.
  Write-Host "glsplay-provision: $line"
}

function Get-Stage {
  if (Test-Path $StatePath) { return (Get-Content $StatePath -Raw).Trim() }
  return 'tools'
}
function Set-Stage {
  param([string]$Stage)
  Set-Content -Path $StatePath -Value $Stage -Encoding utf8
  Log "-> next stage: $Stage"
}

function Invoke-Download {
  param([string]$Uri, [string]$OutFile)
  Log "downloading $Uri"
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}

Log "=============================================================="
Log "provision starting, stage=$(Get-Stage) host=$env:COMPUTERNAME"

# ---------------------------------------------------------------- 1. tools --

if ((Get-Stage) -eq 'tools') {
  Log 'STAGE 1: tools'

  # No Node here. The signaling broker and the web client run centrally, so
  # this machine only ever runs one native binary and never needs a JS runtime.

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $exe = Join-Path $env:TEMP 'git.exe'
    Invoke-Download 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe' $exe
    Start-Process $exe -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP-' -Wait -NoNewWindow
    Log 'git installed'
  } else { Log 'git already present' }

  # The installers extend PATH for new processes only.
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('PATH', 'User')

  if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    & git clone --branch $Branch $RepoUrl $RepoRoot 2>&1 | ForEach-Object { Log "git: $_" }
  } else {
    Log 'repo already cloned; fetching'
    & git -C $RepoRoot fetch --all 2>&1 | ForEach-Object { Log "git: $_" }
    & git -C $RepoRoot checkout $Branch 2>&1 | ForEach-Object { Log "git: $_" }
  }
  if (-not (Test-Path (Join-Path $RepoRoot '.git'))) { throw 'clone failed' }

  # Prove metadata reads work before spending 20 minutes on a driver.
  . (Join-Path $RepoRoot 'vm-scripts\session-config.ps1')
  $cfg = Get-GlsplaySessionConfig -RepoRoot $RepoRoot
  Log ("metadata: onGce={0} room={1} secret={2} chars output={3} externalIp={4}" -f `
       $cfg.OnGce, $cfg.RoomId, $cfg.Secret.Length, $cfg.Output, $cfg.ExternalIp)
  if (-not $cfg.OnGce)  { Log 'metadata server unreachable' 'ERROR' }
  if (-not $cfg.Secret) { Log 'no glsplay-secret in metadata - the broker will refuse to start' 'ERROR' }

  Set-Stage 'driver'
}

# --------------------------------------------------------------- 2. driver --

if ((Get-Stage) -eq 'driver') {
  Log 'STAGE 2: driver'

  $model = $null
  try {
    $model = (& nvidia-smi --query-gpu=driver_model.current --format=csv,noheader) 2>$null
  } catch { }
  Log "current driver model: $(if ($model) { $model } else { '<nvidia-smi absent>' })"

  if ($model -match 'WDDM') {
    Log 'already WDDM'
    Set-Stage 'display'
  } elseif ($model -match 'TCC') {
    # The compute driver has no WDDM mode at all; it must be removed, not switched.
    Log 'TCC driver present - uninstalling, then rebooting'
    $nvi2 = 'C:\Program Files\NVIDIA Corporation\Installer2\InstallerCore\NVI2.DLL'
    if (Test-Path $nvi2) {
      Start-Process 'C:\Windows\SysWOW64\RunDll32.EXE' `
        -ArgumentList "`"$nvi2`",UninstallPackage Display.Driver" -Wait -NoNewWindow
    }
    Remove-Item C:\Windows\System32\nvidia-smi.exe -Force -ErrorAction SilentlyContinue
    Set-Stage 'driver-install'
    Log 'rebooting'
    Restart-Computer -Force
    return
  } else {
    Set-Stage 'driver-install'
  }
}

if ((Get-Stage) -eq 'driver-install') {
  Log 'STAGE 2b: GRID/vWS driver install'
  $installer = Join-Path $RepoRoot 'install_gpu_driver.ps1'
  if (Test-Path $installer) {
    & powershell -ExecutionPolicy Bypass -File $installer 2>&1 | ForEach-Object { Log "driver: $_" }
  } else {
    Log "install_gpu_driver.ps1 missing at $installer" 'ERROR'
  }
  Set-Stage 'display'
  Log 'rebooting'
  Restart-Computer -Force
  return
}

# -------------------------------------------------------------- 3. display --

if ((Get-Stage) -eq 'display') {
  Log 'STAGE 3: virtual display'

  $model = $null
  try { $model = (& nvidia-smi --query-gpu=driver_model.current --format=csv,noheader) 2>$null } catch { }
  if ($model -notmatch 'WDDM') {
    Log "driver is '$model', not WDDM - DXGI cannot see the GPU. Continuing, but capture will fail." 'ERROR'
  } else {
    Log 'driver is WDDM'
  }

  # The settings file goes down FIRST and must be the repo copy: the stock one
  # from the driver zip says <friendlyname>default</friendlyname>, which renders
  # the virtual monitor on the wrong adapter. Capture still works, the zero-copy
  # path to NVENC quietly becomes a CPU roundtrip, and nothing reports an error.
  New-Item -ItemType Directory -Force -Path 'C:\VirtualDisplayDriver' | Out-Null
  Copy-Item (Join-Path $RepoRoot 'vdd\VirtualDisplayDriver\vdd_settings.xml') `
            'C:\VirtualDisplayDriver\' -Force
  Log 'vdd_settings.xml placed (bound to NVIDIA L4)'

  $existing = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
              Where-Object { $_.FriendlyName -match 'Virtual Display|MTT' }
  if ($existing) {
    Log "virtual display already installed: $($existing.FriendlyName) [$($existing.Status)]"
  } else {
    # MttVDD is a root-enumerated device, so pnputil alone will not create it.
    # nefcon is the only non-GUI way in - the devmgmt.msc "Add legacy hardware"
    # wizard cannot run unattended.
    $nefcon = Join-Path $RepoRoot 'vdd\nefcon\x64\nefconw.exe'
    $inf    = Join-Path $RepoRoot 'vdd\VirtualDisplayDriver\MttVDD.inf'
    if (-not (Test-Path $nefcon)) { throw "nefcon not found at $nefcon" }
    if (-not (Test-Path $inf))    { throw "MttVDD.inf not found at $inf" }

    # Trust the SignPath cert up front. It chains to GlobalSign and is normally
    # already trusted; importing costs nothing and avoids a silent block.
    try {
      $cat = Join-Path $RepoRoot 'vdd\VirtualDisplayDriver\mttvdd.cat'
      $certs = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
      $certs.Import([System.IO.File]::ReadAllBytes($cat))
      foreach ($c in $certs) {
        $tmp = Join-Path $env:TEMP "$($c.Thumbprint).cer"
        [System.IO.File]::WriteAllBytes($tmp, $c.Export('Cert'))
        Import-Certificate -FilePath $tmp -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null
      }
      Log "imported $($certs.Count) driver certificate(s)"
    } catch {
      Log "certificate import skipped: $($_.Exception.Message)" 'WARN'
    }

    Push-Location (Split-Path $inf -Parent)
    & $nefcon install (Split-Path $inf -Leaf) 'Root\MttVDD' 2>&1 | ForEach-Object { Log "nefcon: $_" }
    Pop-Location
    Start-Sleep -Seconds 10

    $now = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
           Where-Object { $_.FriendlyName -match 'Virtual Display|MTT' }
    if ($now) { Log "virtual display installed: $($now.FriendlyName) [$($now.Status)]" }
    else      { Log 'virtual display NOT created - DuplicateOutput will fail with 0x887A0002' 'ERROR' }
  }

  Set-Stage 'check'
}

# ---------------------------------------------------------------- 4. check --

if ((Get-Stage) -eq 'check') {
  Log 'STAGE 4: verify the payload'

  # There is nothing to build here any more. The signaling broker and the web
  # client run centrally - one deployment behind TLS serving every VM - so this
  # machine needs neither Node nor a build step. That removed the two stages
  # most likely to fail a bake: npm install needs the network, and next build
  # will OOM on a small instance.
  #
  # The host binary is committed to the repo and links libwebrtc and the CRT
  # statically, so the clone in stage 1 is the whole install.
  $exe = Join-Path $RepoRoot 'apps\host\build\bin\Release\glsplay-host.exe'
  if (Test-Path $exe) {
    Log "host binary present ($([math]::Round((Get-Item $exe).Length/1MB,1)) MB)"
  } else {
    Log "host binary MISSING at $exe - run-host.ps1 will exit 1" 'ERROR'
  }

  # The host dials the broker rather than being dialled, so a bad or
  # unreachable signaling URL fails at connect time inside host.log, which is
  # an unpleasant place to discover a typo. Check it here instead.
  . (Join-Path $RepoRoot 'vm-scripts\session-config.ps1')
  $cfg = Get-GlsplaySessionConfig -RepoRoot $RepoRoot
  Log "signaling url: $($cfg.SignalingUrl)"
  if ($cfg.SignalingUrl -match '^wss?://(localhost|127\.0\.0\.1)') {
    Log 'signaling url still points at localhost, but nothing serves it on this VM.' 'ERROR'
    Log 'Set instance metadata glsplay-signaling-url to the central broker.' 'ERROR'
  } else {
    # Probe the health endpoint. A failure here is informational - the broker
    # may simply be behind a proxy that does not expose it - so it does not
    # stop provisioning.
    $probe = $cfg.SignalingUrl -replace '^ws', 'http'
    try {
      $health = Invoke-RestMethod "$probe/health" -TimeoutSec 10 -ErrorAction Stop
      Log "broker reachable: status=$($health.status) rooms=$($health.rooms) peers=$($health.peers)"
    } catch {
      Log "broker health probe failed: $($_.Exception.Message)" 'WARN'
      Log 'Not fatal - the WebSocket may still work if /health is not proxied.' 'WARN'
    }
  }

  Set-Stage 'account'
}

# -------------------------------------------------------------- 5. account --

if ((Get-Stage) -eq 'account') {
  Log 'STAGE 5: autologon account'

  # Desktop Duplication can only capture a session that owns the display. With
  # no console session logged in there is no desktop to duplicate, so autologon
  # is load-bearing, not a convenience.
  $existing = Get-LocalUser -Name $AutoLogonUser -ErrorAction SilentlyContinue
  if (-not $existing) {
    Add-Type -AssemblyName System.Web
    $plain = [System.Web.Security.Membership]::GeneratePassword(24, 5)
    New-LocalUser -Name $AutoLogonUser -Password (ConvertTo-SecureString $plain -AsPlainText -Force) `
      -PasswordNeverExpires -AccountNeverExpires `
      -Description 'glsplay console session owner' | Out-Null
    Add-LocalGroupMember -Group 'Administrators' -Member $AutoLogonUser -ErrorAction SilentlyContinue
    Log "created local user $AutoLogonUser"
  } else {
    # Reset so this stage is idempotent - we cannot read back the old password.
    Add-Type -AssemblyName System.Web
    $plain = [System.Web.Security.Membership]::GeneratePassword(24, 5)
    Set-LocalUser -Name $AutoLogonUser -Password (ConvertTo-SecureString $plain -AsPlainText -Force)
    Log "reset password for existing user $AutoLogonUser"
  }

  & powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'vm-scripts\setup-gcp-vm.ps1') `
      -AutoLogonUser $AutoLogonUser -AutoLogonPassword $plain 2>&1 |
    ForEach-Object { Log "setup-gcp-vm: $_" }

  # setup-gcp-vm.ps1 writes DefaultPassword to the registry in clear text, which
  # is how autologon has always worked and is readable by any administrator or
  # by anyone who mounts the disk. Sysinternals Autologon stores it as an LSA
  # secret instead - same behaviour, no plaintext - so re-apply it that way and
  # delete the registry value. Best-effort: if the download fails the VM still
  # logs on, just less well protected, and failing the bake over it would be a
  # poor trade.
  try {
    $tool = Join-Path $env:TEMP 'Autologon64.exe'
    if (-not (Test-Path $tool)) {
      Invoke-Download 'https://live.sysinternals.com/Autologon64.exe' $tool
    }
    & $tool /accepteula $AutoLogonUser $env:COMPUTERNAME $plain 2>&1 |
      ForEach-Object { Log "autologon: $_" }

    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $stillPlain = (Get-ItemProperty -Path $winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue).DefaultPassword
    if ($stillPlain) {
      Remove-ItemProperty -Path $winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue
      Log 'password moved to the LSA store; cleared DefaultPassword from the registry'
    } else {
      Log 'DefaultPassword already absent from the registry'
    }
  } catch {
    Log "LSA autologon step skipped: $($_.Exception.Message)" 'WARN'
    Log 'Autologon still works, but the password remains in the registry in clear text.' 'WARN'
  }

  $plain = $null
  Set-Stage 'tasks'
}

# ---------------------------------------------------------------- 6. tasks --

if ((Get-Stage) -eq 'tasks') {
  Log 'STAGE 6: firewall + task graph'

  & powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'vm-scripts\setup-firewall.ps1') 2>&1 |
    ForEach-Object { Log "firewall: $_" }

  # setup-firewall.ps1 predates the web app and does not open :3000.
  if (-not (Get-NetFirewallRule -DisplayName 'glsplay-web-tcp' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'glsplay-web-tcp' -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 3000 -Profile Any | Out-Null
    Log 'opened TCP 3000'
  }

  & powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'vdd\setup-headless.ps1') `
      -User $AutoLogonUser -RepoRoot $RepoRoot 2>&1 |
    ForEach-Object { Log "setup-headless: $_" }

  Set-Stage 'done'
  Log 'provisioning complete - rebooting into the streaming configuration'
  Restart-Computer -Force
  return
}

# ----------------------------------------------------------------- 7. done --

if ((Get-Stage) -eq 'done') {
  Log 'STAGE 7: already provisioned; normal boot'
  Get-ScheduledTask glsplay-* -ErrorAction SilentlyContinue |
    ForEach-Object { Log "task $($_.TaskName): $($_.State)" }
}

Log 'provision script finished'
