# Automation — from hand-built VM to disposable instance

`docs/DEPLOY-GCP-L4.md` describes building one VM by hand. This describes making
that VM's disk into an image any number of instances can boot from, with no file
edited and nobody logging in.

The rule this enforces: **nothing on the disk is per-instance.** Room, secret and
broker URL arrive from GCE instance metadata at boot. If you find yourself
editing a file on a running VM to make it stream, that is a bug in this layer.

---

## 0. One command

`vm-scripts/provision.ps1` takes a bare Windows Server 2022 + L4 instance all
the way to streaming, with no RDP session at any point:

```bash
PROJECT=<your-project>
ZONE=asia-south1-b
SECRET=$(openssl rand -hex 32)
BROKER=play.example.com            # your control-plane host

gcloud compute instances create glsplay-1 --project=$PROJECT --zone=$ZONE \
  --machine-type=g2-standard-4 \
  --image-family=windows-2022 --image-project=windows-cloud \
  --boot-disk-size=200GB --enable-display-device \
  --metadata="glsplay-secret=$SECRET,glsplay-room=poc,glsplay-signaling-url=wss://$BROKER/ws" \
  --metadata-from-file="windows-startup-script-ps1=vm-scripts/provision.ps1"
```

Then wait. Roughly 25–35 minutes, most of it the NVIDIA driver.

GCE runs a Windows startup script on **every** boot, which is what makes this
resumable at no cost: the script keeps a stage in `C:\glsplay-provision\state.txt`,
and the driver's two reboots simply re-enter it at the next stage. Watch a
machine you have never logged into:

```bash
gcloud compute instances get-serial-port-output glsplay-1 --zone=$ZONE \
  | grep glsplay-provision
```

Stages: `tools` (Git, clone) → `driver` (TCC → GRID/vWS, 2 reboots) →
`display` (settings file, then MTT VDD via nefcon — no GUI wizard) → `check` →
`account` (dedicated local user + autologon) → `tasks` → `done`.

When the log reaches `provisioning complete`, open the central web client.

The GPU VM needs **no inbound TCP at all**. The broker and the web client are a
separate always-on deployment, and the host dials out to it — so the only port
that has to be reachable here is the media range:

```bash
gcloud compute firewall-rules create glsplay-media --project=$PROJECT \
  --allow udp:50000-50100 --source-ranges=0.0.0.0/0
```

Ports 8080 and 3000 belong to the control-plane box, not to this one.

The sections below describe what that script automates, and are what you want
when a stage fails or when you are baking an image to skip the 30 minutes.

> Prefer to watch each step, or finishing a stage the script stopped on?
> **`docs/MANUAL-BAKE.md`** walks the same sequence by hand: manual for the
> once-only half (tools, driver, display), then hands the per-instance half
> (account, tasks) back to this script, because those two cannot be baked in.

---

## 1. Metadata keys

Set on the instance at create time. Everything is optional except the secret.

| Key | Default | Meaning |
|---|---|---|
| `glsplay-secret` | *(none — required)* | Room secret, presented by broker, host and browser |
| `glsplay-room` | `poc` | Room id |
| `glsplay-signaling-url` | `ws://localhost:8080` | Broker URL the host dials. **Must be set** — the default is a leftover from when the broker ran on the VM, and nothing serves it here now. Use `wss://<your-domain>/ws` |
| `glsplay-output` | `1` | DXGI output to duplicate. `1` = Virtual Display Driver, `0` = L4 phantom head |
| `glsplay-audio` | `off` | `on` enables WASAPI loopback (needs a virtual audio device) |
| `glsplay-log-level` | `debug` | `debug` \| `info` \| `warn` \| `error` |

Resolution order is metadata → process env → machine env → repo `.env` → default,
so the same scripts run unchanged on a workstation with no metadata server. Check
what an instance resolved:

```powershell
.\vm-scripts\session-config.ps1 -Show
```

---

## 2. Task graph

Registered once by `vdd\setup-headless.ps1`, then baked into the image.

| Task | Trigger | Runs as | Action |
|---|---|---|---|
| `glsplay-boot` | At startup | SYSTEM | `vm-scripts\boot.ps1` |
| `glsplay-host` | At logon + 45s | autologon user | `run-host.ps1` |
| `glsplay-reclaim` | RDP disconnect | SYSTEM | `vdd\reclaim-console.ps1` |

```
boot
 ├─ glsplay-boot (SYSTEM)
 │    ├─ metadata → machine env + .env
 │    └─ check the central broker answers    → boot.log
 │
 └─ autologon → console session
      └─ glsplay-host (+45s, interactive, restarts 3x on failure)
           ├─ vdd\set-vdd-res.ps1  pin 1920x1080@60
           └─ glsplay-host.exe --output 1     → host.log
                └─ dials wss://<broker>/ws
```

There used to be `glsplay-signaling` and `glsplay-web` tasks here, one copy of
each per GPU VM. They are now a single central deployment behind TLS, so this
machine runs one native binary and needs no JS runtime. `setup-headless.ps1`
unregisters them if an older image still carries them.

**The host runs off a logon trigger, not off RDP disconnect.** With autologon the
console session exists from boot, so there is nothing to reclaim and no human in
the loop. `glsplay-reclaim` is now the exception path — it only matters if
somebody RDPs in to look at logs and then disconnects.

The host task uses a `LogonType Interactive` principal. An S4U or ServiceAccount
principal lands in session 0, which has no desktop, and Desktop Duplication then
has nothing to duplicate.

---

## 3. Browser config at runtime

`next build` inlines `NEXT_PUBLIC_*` into the bundle. That is fatal to a reusable
image: a per-session room or secret would mean rebuilding the front end on every
boot.

So the browser fetches `/api/session` at page load, and that route reads
`process.env` per request (`dynamic = 'force-dynamic'`). Since the web client is
now deployed centrally rather than once per VM, that environment comes from the
control-plane box — no GPU VM is involved in serving it. The `NEXT_PUBLIC_*` path
still works as a fallback so `npm run dev` on a laptop needs only a root `.env`.

> **The secret is served from an unauthenticated endpoint**, and that assessment
> has changed. While the client was built per VM and served off a throwaway IP,
> the value was inlined into the bundle anyway, so serving it exposed nothing
> new. A permanent public domain moves the exposure from the bundle to the URL —
> and the URL does not rotate when a VM does. Whoever has the secret can join a
> live session as the client, and the host injects `SendInput`. See `TODO.md`;
> the fix is per-session tokens.

---

## 4. Baking an image

On a VM brought up per `docs/DEPLOY-GCP-L4.md` §3–§6 and verified streaming:

```powershell
# Register the task graph. Reads the autologon user from the registry;
# pass -User to override.
powershell -ExecutionPolicy Bypass -File C:\glsplay\vdd\setup-headless.ps1
```

There is nothing to build. The broker and the web client are deployed centrally,
so no JS is compiled or run on this machine. The host binary must already be at
the path `run-host.ps1` checks — no script builds it, and a missing exe is a
one-line `host.log` and nothing else:

```powershell
Test-Path C:\glsplay\apps\host\build\bin\Release\glsplay-host.exe   # must be True
```

Either build it here per `docs/BUILD-HOST.md`, or copy a prebuilt one in. Copying
is usually better: the exe links libwebrtc and the CRT statically and resolves
`nvEncodeAPI64.dll` / `nvml.dll` from the driver at runtime, so it needs nothing
beside it and the image carries no toolchain, no `third_party/`, and no reason to
keep MSVC installed on a machine whose job is to stream.

Then strip everything that names this one instance:

```powershell
powershell -ExecutionPolicy Bypass -File C:\glsplay\vm-scripts\bake-image.ps1
```

It removes the `.env`, the machine `GLSPLAY_ROOM_SECRET`, the autologon
credentials — both the registry values and the LSA secret — the local account
and its profile, the scheduled tasks bound to it, and every log. Then it rewinds
`provision.ps1`'s stage marker to `account`.

That rewind is the whole trick. The image carries the slow half — Git, the repo
including the host binary, the WDDM driver, the virtual display device — and the
first boot of a new instance re-runs only the last two stages: create a local
user with a freshly generated password, register the task graph, reboot into
streaming. Two minutes rather than twenty-five, and **each instance gets its own
credentials** instead of inheriting one password baked into the image.

> `bake-image.ps1` deliberately does not run `GCESysprep`. Sysprep `/generalize`
> tears down root-enumerated devices, and `MttVDD` is one — the virtual display
> would not survive, which is the most tedious thing in the image to rebuild.
> The cost is a shared machine SID, which matters for Active Directory and some
> licensing and not at all for disposable single-tenant gaming VMs. If you do
> need sysprep, pass `-ResumeStage display` so the VDD is recreated on first boot.

```bash
gcloud compute instances stop $INSTANCE --zone=$ZONE
gcloud compute images create glsplay-$(date +%Y%m%d) \
  --source-disk=$INSTANCE --source-disk-zone=$ZONE --family=glsplay
```

## 5. Launching an instance

```bash
SECRET=$(openssl rand -hex 32)
BROKER=play.example.com            # your control-plane host

gcloud compute instances create glsplay-session-1 \
  --zone=$ZONE --machine-type=g2-standard-4 \
  --image-family=glsplay --image-project=$PROJECT \
  --enable-display-device \
  --metadata="glsplay-secret=$SECRET,glsplay-room=session-1,glsplay-signaling-url=wss://$BROKER/ws" \
  --metadata-from-file="windows-startup-script-ps1=vm-scripts/provision.ps1"
```

The startup script is still required against a baked image — it is what runs the
two stages `bake-image.ps1` rewound to. On first boot it creates the local
account, registers the task graph and reboots; from the second boot on it sees
stage `done` and just logs the task states.

So: **first boot from the image about two minutes, every boot after that about
ninety seconds.** The instance resolves its metadata, autologons, and the host
begins capturing 45 seconds later, dialling out to the central broker. Open the
web client at your own domain — the GPU VM serves no web page of its own.

Verify from the guest without disturbing the stream — RDP re-steals the display,
so read the logs and disconnect again:

```powershell
Get-Content C:\glsplay\boot.log            # metadata resolution, broker health
Get-Content C:\glsplay\host.log -Tail 40   # DXGI, NVENC, ICE
```

---

## 6. What is still manual

Phase 0 got one instance to boot and stream untouched. Still to come:

- **Image bake is hand-run.** Should be Packer, so the image is reproducible from
  source rather than from a VM somebody configured correctly once.
- **No control plane.** Instance creation, the room/secret, and teardown are all
  `gcloud` by hand. Next: an API that allocates an instance, waits for the host
  to register, and returns connect details.
- **Broker still runs on the VM.** Moving it to one always-on `wss://` endpoint
  removes the external-IP derivation above, and is what makes TLS possible — an
  `https://` page cannot open `ws://`.
- **One shared secret per instance, no expiry.** Replace with per-session tokens.
- **Cold boot is the only path.** A warm pool is what makes the wait tolerable,
  and paying for idle L4s is the central cost question, not a technical one.
