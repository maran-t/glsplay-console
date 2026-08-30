# Building the golden image by hand

`vm-scripts/provision.ps1` automates all of this. Use this document instead when
you want to watch each step, or when a stage failed and you are finishing it
yourself.

The split matters, and it is the same split the script uses:

| Stages | Run | Where they end up |
|---|---|---|
| tools, driver, display | **once, by hand** | frozen into the image |
| account, tasks | **every new instance** | must stay automated |

The second half cannot be baked. Every instance needs its own local account
password and its own task registration — bake those in and every VM in the fleet
shares one credential.

---

## 1. Create the VM

```powershell
$PROJECT = '<your-project>'
$ZONE    = 'asia-south1-b'
$VM      = 'glsplay-golden'

gcloud.cmd compute instances create $VM --project=$PROJECT --zone=$ZONE `
  --machine-type=g2-standard-4 `
  --image-family=windows-2022 --image-project=windows-cloud `
  --boot-disk-size=200GB --boot-disk-type=pd-balanced `
  --enable-display-device
```

No metadata yet — nothing reads it while you are working by hand.

**Confirm the GPU is actually attached before going further.** A VM without one
looks identical until DXGI reports three "Microsoft Basic Render Driver" adapters
with 0 MB VRAM, twenty minutes later:

```powershell
gcloud.cmd compute instances describe $VM --project=$PROJECT --zone=$ZONE `
  --format="yaml(machineType,guestAccelerators)"
#   want:  type: .../nvidia-l4   count: 1
```

Get a password and RDP in:

```powershell
gcloud.cmd compute reset-windows-password $VM --project=$PROJECT --zone=$ZONE
```

---

## 2. Tools

Only Git. The broker and the web client run centrally, so this machine never
needs Node, npm or a build step.

Download and install <https://git-scm.com/download/win>, then:

```powershell
git clone --branch phase0-metadata-boot https://github.com/maran-t/glsplay.git C:\glsplay
```

The host binary comes with the clone — it is committed, links libwebrtc and the
CRT statically, and resolves `nvEncodeAPI64.dll` / `nvml.dll` from the driver at
runtime. No Visual Studio, no `third_party/`, nothing to build.

```powershell
Test-Path C:\glsplay\apps\host\build\bin\Release\glsplay-host.exe    # must be True
```

---

## 3. GPU driver — into WDDM mode

GCP ships the compute (Tesla/CUDA) driver, which runs the GPU in **TCC** mode.
DXGI cannot see a TCC device at all, and that driver has no WDDM mode to switch
to — `nvidia-smi -dm 0` returns *"Not Supported"*. It has to be replaced.

```powershell
nvidia-smi --query-gpu=name,driver_version,driver_model.current --format=csv
```

- Reports **WDDM** → skip to step 4.
- Reports **TCC** → uninstall it first, then reboot:

```powershell
Start-Process -Verb RunAs -Wait -FilePath "C:\Windows\SysWOW64\RunDll32.EXE" `
  -ArgumentList '"C:\Program Files\NVIDIA Corporation\Installer2\InstallerCore\NVI2.DLL",UninstallPackage Display.Driver'
Remove-Item C:\Windows\System32\nvidia-smi.exe -Force -ErrorAction SilentlyContinue
Restart-Computer
```

- Command not found at all → no driver installed; go straight to the install.

Install the GRID/vWS driver. The repo script auto-detects the GCP multi-region
and pins the package hash:

```powershell
powershell -ExecutionPolicy Bypass -File C:\glsplay\install_gpu_driver.ps1
Restart-Computer
```

### Verify — do not skip

```powershell
nvidia-smi --query-gpu=name,driver_model.current --format=csv
#   want:  NVIDIA L4, WDDM
Test-Path C:\Windows\System32\nvEncodeAPI64.dll     # must be True - this is NVENC
```

Anything other than `WDDM` here and nothing downstream can work.

---

## 4. Virtual display

WDDM is not enough. A datacenter L4 has **no display head**, so
`IDXGIOutputDuplication::DuplicateOutput` fails with `0x887A0002` until an
indirect display driver exists.

### 4a. Settings file first

The path is hardcoded in the driver, and the file must be the repo's copy — the
stock one from the upstream zip says `<friendlyname>default</friendlyname>`,
which renders the virtual monitor on the wrong adapter. Capture still appears to
work, the zero-copy path to NVENC quietly becomes a CPU roundtrip, and nothing
reports an error.

```powershell
New-Item -ItemType Directory -Force -Path C:\VirtualDisplayDriver
Copy-Item C:\glsplay\vdd\VirtualDisplayDriver\vdd_settings.xml C:\VirtualDisplayDriver\
Select-String -Path C:\VirtualDisplayDriver\vdd_settings.xml -Pattern 'friendlyname'
#   want:  <friendlyname>NVIDIA L4</friendlyname>
```

### 4b. Create the device

`MttVDD` is root-enumerated, so `pnputil` alone will not spawn it. Two ways in:

**Scripted** — the bundled nefcon, no GUI, works over RDP:

```powershell
cd C:\glsplay\vdd\VirtualDisplayDriver
C:\glsplay\vdd\nefcon\x64\nefconw.exe install MttVDD.inf "Root\MttVDD"
Start-Sleep -Seconds 10
```

**Or by wizard** — `devmgmt.msc` → Action → Add legacy hardware → Next →
"Install the hardware that I manually select" → "Display adapters" →
"Have Disk…" → `C:\glsplay\vdd\VirtualDisplayDriver\MttVDD.inf` →
"Virtual Display Driver by MTT" → Finish.

### Verify

```powershell
Get-PnpDevice -Class Display | Select-Object Status, FriendlyName
#   want a "Virtual Display Driver" entry with Status OK
```

---

## 5. Hand the rest to the script

Everything above is now frozen-worthy. The remaining two stages must run on every
instance anyway, so run them the way the fleet will:

```powershell
New-Item -ItemType Directory -Force -Path C:\glsplay-provision
Set-Content C:\glsplay-provision\state.txt 'account' -Encoding utf8

powershell -ExecutionPolicy Bypass -File C:\glsplay\vm-scripts\provision.ps1
```

Setting the marker to `account` is what stops it repeating the work you just did
by hand. It creates the local `glsplay` user with a generated password, enables
autologon, stores the password as an LSA secret, registers the task graph, and
reboots.

---

## 6. Prove it streams — before baking anything

Set the session config and let the host come up on its own:

```powershell
gcloud.cmd compute instances add-metadata $VM --project=$PROJECT --zone=$ZONE `
  --metadata="glsplay-secret=<same as your broker>,glsplay-room=poc,glsplay-signaling-url=wss://<your-domain>/ws"
```

Also open the media port, once per project:

```powershell
gcloud.cmd compute firewall-rules create glsplay-media --project=$PROJECT `
  --allow udp:50000-50100 --source-ranges=0.0.0.0/0
```

Then **disconnect RDP and leave it alone.** Autologon owns the console session;
connecting steals the display back and capture stops. Open your web client and
click the video.

If it does not come up, reconnect once and read, in this order:

```powershell
Get-Content C:\glsplay\boot.log                       # metadata + broker reachable?
Get-ScheduledTask glsplay-* | Select TaskName, State, LastTaskResult
Get-Content C:\glsplay\host.log -Tail 40              # DXGI, NVENC, ICE
```

`host.log` should show `running in the console session`,
`DXGI adapters: [0] NVIDIA L4 ... outputs=2`, and
`DXGI duplication ready: NVIDIA L4 1920x1080`. `outputs=0` means it ran while the
session was still on RDP.

**Do not bake until you have seen a live picture in the browser.** Baking a VM
that does not stream copies the fault into every instance you ever launch, and
you debug it repeatedly instead of once.

---

## 7. What must be on disk for a new instance to work

After the bake, an instance created from the image finds:

| Path | Why |
|---|---|
| `C:\glsplay\` | the repo, including the host binary and every script |
| `C:\glsplay-provision\state.txt` = `account` | tells `provision.ps1` where to resume |
| `C:\VirtualDisplayDriver\vdd_settings.xml` | hardcoded path, binds the VDD to the L4 |

Plus driver and device state in the registry, which the disk image carries
automatically.

Nothing else. No `.env` — `boot.ps1` writes it from metadata on every boot. No
secret, no account, no tasks; those are created per instance.

And one thing that is **not** on disk: the startup script. It lives in instance
metadata, so it must be passed on every `instances create`, including creates
from your own image. It is what runs the stages the bake rewound to.

---

## 8. Bake

```powershell
powershell -ExecutionPolicy Bypass -File C:\glsplay\vm-scripts\bake-image.ps1
```

```powershell
gcloud.cmd compute instances stop $VM --project=$PROJECT --zone=$ZONE

gcloud.cmd compute images create ("glsplay-" + (Get-Date -Format 'yyyyMMdd')) `
  --project=$PROJECT --source-disk=$VM --source-disk-zone=$ZONE --family=glsplay
```

## 9. Launch from it

```powershell
$SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

gcloud.cmd compute instances create glsplay-1 --project=$PROJECT --zone=$ZONE `
  --machine-type=g2-standard-4 `
  --image-family=glsplay --image-project=$PROJECT `
  --enable-display-device `
  --metadata="glsplay-secret=$SECRET,glsplay-room=poc,glsplay-signaling-url=wss://<your-domain>/ws" `
  --metadata-from-file="windows-startup-script-ps1=vm-scripts\provision.ps1"
```

Run that from the repo root — `vm-scripts\provision.ps1` is a path on **your**
machine, read at create time and uploaded into metadata.

Watch the serial console for `STAGE 5: autologon account`. If it says
`STAGE 1: tools` instead, the rewind did not take and it is about to repeat the
whole thing.

Use a **different secret** than the golden VM had. If the new instance streams
with it, that proves nothing instance-specific survived the bake.

---

## When to rebuild the image

The image contains a `git clone` pinned to whatever commit existed when you baked
it, and the `tools` stage that would update it is skipped on image boot. So
**pushing code does not reach existing images.** Rebake after:

- any repo change affecting the VM side
- an NVIDIA driver update
- Windows patching you want baked rather than applied per instance

That is the argument for `provision.ps1` over doing this by hand every time — not
the first build, the fifth.
