# Automation — from hand-built VM to disposable instance

`docs/DEPLOY-GCP-L4.md` describes building one VM by hand. This describes making
that VM's disk into an image any number of instances can boot from, with no file
edited and nobody logging in.

The rule this enforces: **nothing on the disk is per-instance.** Room, secret and
broker URL arrive from GCE instance metadata at boot. If you find yourself
editing a file on a running VM to make it stream, that is a bug in this layer.

---

## 1. Metadata keys

Set on the instance at create time. Everything is optional except the secret.

| Key | Default | Meaning |
|---|---|---|
| `glsplay-secret` | *(none — required)* | Room secret, presented by broker, host and browser |
| `glsplay-room` | `poc` | Room id |
| `glsplay-signaling-url` | `ws://localhost:8080` | Broker URL **the host dials**. Loopback while the broker runs on the VM |
| `glsplay-public-signaling-url` | derived from the external IP | Broker URL **the browser dials**. Derived as `ws://<external-ip>:8080` when unset |
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
| `glsplay-signaling` | *(none)* | SYSTEM | `npm start -w @glsplay/signaling` |
| `glsplay-web` | *(none)* | SYSTEM | `npm start -w @glsplay/web` |
| `glsplay-host` | At logon + 45s | autologon user | `run-host.ps1` |
| `glsplay-reclaim` | RDP disconnect | SYSTEM | `vdd\reclaim-console.ps1` |

```
boot
 ├─ glsplay-boot (SYSTEM)
 │    ├─ metadata → machine env + apps\web\.env
 │    ├─ start glsplay-signaling, then glsplay-web
 │    └─ wait for /health, up to 90s          → boot.log
 │
 └─ autologon → console session
      └─ glsplay-host (+45s, interactive)
           ├─ vdd\set-vdd-res.ps1  pin 1920x1080@60
           └─ glsplay-host.exe --output 1     → host.log
```

Two things changed here versus the hand-built VM, and both matter.

**The service tasks lost their own triggers.** They are started by `glsplay-boot`,
in order, so config is on disk before `next start` reads it. Two `At startup`
tasks have no defined sequence relative to each other, and the web app coming up
against a stale `.env` because it won the race is a bug that looks like a caching
problem for a day.

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

So the browser now fetches `/api/session` at page load, and that route reads
`process.env` per request (`dynamic = 'force-dynamic'`). `boot.ps1` writes
`apps/web/.env` before starting the web task, `next start` reads it, and the
bundle itself is built once at bake time. The `NEXT_PUBLIC_*` path still works as
a fallback so `npm run dev` on a laptop needs nothing but a root `.env`.

> The secret is served from an unauthenticated endpoint. That is exactly as
> exposed as the inlined build-time value it replaces — no better, no worse.
> Phase 2 replaces it with a short-lived per-session token minted by the control
> plane after the user authenticates. Until then, keep the VM firewalled.

---

## 4. Baking an image

On a VM brought up per `docs/DEPLOY-GCP-L4.md` §3–§6 and verified streaming:

```powershell
# Register the task graph. Reads the autologon user from the registry;
# pass -User to override.
powershell -ExecutionPolicy Bypass -File C:\glsplay\vdd\setup-headless.ps1

# Build once, here, so instances don't build at boot.
cd C:\glsplay
npm ci
npm run build -w @glsplay/protocol
npm run build -w @glsplay/signaling
npm run build -w @glsplay/web
```

The host binary must already be at the path `run-host.ps1` checks — no script
builds it, and a missing exe is a one-line `host.log` and nothing else:

```powershell
Test-Path C:\glsplay\apps\host\build\bin\Release\glsplay-host.exe   # must be True
```

Either build it here per `docs/BUILD-HOST.md`, or copy a prebuilt one in. Copying
is usually better: the exe links libwebrtc and the CRT statically and resolves
`nvEncodeAPI64.dll` / `nvml.dll` from the driver at runtime, so it needs nothing
beside it and the image carries no toolchain, no `third_party/`, and no reason to
keep MSVC installed on a machine whose job is to stream.

Then remove anything instance-specific before the snapshot — a stale secret in a
baked `.env` silently wins over metadata on every instance that boots from the
image:

```powershell
Remove-Item C:\glsplay\.env, C:\glsplay\apps\web\.env -Force -ErrorAction SilentlyContinue
Remove-Item C:\glsplay\*.log, C:\glsplay\*.log.* -Force -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable('GLSPLAY_ROOM_SECRET', $null, 'Machine')
```

```bash
gcloud compute instances stop $INSTANCE --zone=$ZONE
gcloud compute images create glsplay-$(date +%Y%m%d) \
  --source-disk=$INSTANCE --source-disk-zone=$ZONE --family=glsplay
```

## 5. Launching an instance

```bash
SECRET=$(openssl rand -hex 32)

gcloud compute instances create glsplay-session-1 \
  --zone=$ZONE --machine-type=g2-standard-4 \
  --image-family=glsplay --image-project=$PROJECT \
  --metadata=glsplay-secret=$SECRET,glsplay-room=session-1
```

Nothing else. The instance boots, resolves its metadata, starts the broker and
web app, autologons, and the host begins capturing 45 seconds later. Point a
browser at `http://<external-ip>:3000`.

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
