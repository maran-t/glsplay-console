# TODO

Open items, roughly in the order they should be dealt with.

> This repo is **public**. Never put a secret, password or token in here — reference
> where it lives instead.

---

## Security

- [ ] **The room secret is served publicly and unauthenticated.**
      `apps/web/src/app/api/session/route.ts` returns `{signalingUrl, roomId, secret}`
      to anyone who requests `https://play.resrve.xyz/api/session`. Whoever has it can
      join a live session as the client — and the host injects `SendInput`, so that is
      keyboard and mouse control of the desktop — or claim the host role in any room
      that currently has none.

      This was an acceptable trade while the client was a throwaway IP: the value was
      inlined into the JS bundle anyway, so serving it changed nothing. A permanent
      public domain changes it. The bundle is no longer the exposure — the URL is.

      **Fix:** per-session tokens minted by the control plane after the user
      authenticates, replacing the one shared secret. Short expiry, scoped to one room
      and one role, so a leaked token dies on its own and cannot claim `host`.
      The broker's single `GLSPLAY_ROOM_SECRET` check (`apps/signaling/src/server.ts:35`,
      `secretMatches`) becomes token verification.

      **Interim, if tokens are not close:** put the session endpoint behind basic auth,
      or restrict the Caddy site to known source IPs. Neither is a real answer.

      **Also:** rotate the current secret. It has been pasted into a chat transcript.

---

## Correctness

- [ ] **`/ws/health` returns 404.** Caddy forwards but does not strip the prefix, so the
      broker sees `/ws/health` and falls through to its 404 handler. WebSockets are
      unaffected — `WebSocketServer({ server })` accepts upgrades on any path, which is
      why the 101 works. Change `handle /ws*` to `handle_path /ws*` in the Caddyfile.
      Needed before anything can monitor the broker.

- [ ] **Verify `glsplay-host.exe` is not stale.** The committed binary is dated
      2026-08-28 20:58. Check whether `00b80c4` ("load NVML from nvml.dll at runtime")
      landed after that — if so the GPU and encoder percentages in the stats HUD read 0
      and the committed exe predates the fix. `git log -1 --format=%ci 00b80c4`.

- [ ] **Delete `vm-scripts/run-host.ps1`.** Stale duplicate of the root `run-host.ps1`,
      not updated in Phase 0. It has no `--output` flag, so it captures output 0 — the
      L4's 1280x800 phantom head instead of the 1920x1080 virtual display. Nothing
      references it. It fails by working, which is the worst way.

- [ ] **Delete `vdd/changeres-VDD.ps1`.** Dot-sources `set-dependencies.ps1`, which is
      not in the repo. Fails on contact. Superseded by `vdd/set-vdd-res.ps1`.

---

## Simplification — now that the control plane is external

- [x] **Strip the Node half out of the VM image.** The `build` stage became `check`,
      the Node install is gone, the `glsplay-signaling` and `glsplay-web` tasks are
      unregistered, and `boot.ps1` no longer writes `apps/web/.env`. Two stages that
      could fail a bake — `npm install` needing the network, `next build` running out
      of memory — no longer exist.

- [x] **Close the GPU VM's inbound TCP.** Docs now create only the UDP 50000-50100
      rule. Verify the old `glsplay-signaling` / `glsplay-web` VPC rules are gone
      from the project if nothing else uses them.

- [x] **Remove dead code.** `Test-Reboot` in `provision.ps1` and `Write-GlsplayWebEnv`
      in `session-config.ps1`, both unreferenced.

- [x] **Autologon password out of the plaintext registry.** `provision.ps1` now
      re-applies it with Sysinternals Autologon, which stores it as an LSA secret,
      and clears `DefaultPassword`. `bake-image.ps1` clears both forms.

- [x] **Restart-on-failure for the host task.** Three retries a minute apart. Not a
      substitute for a supervisor service — it cannot relaunch across a session
      change — but it covers the ordinary case of the host exiting.

---

## Robustness

- [ ] **Pinned installer URLs will 404.** `provision.ps1` hardcodes exact Node (:96) and
      Git (:104) download URLs. Both will break when those releases are pruned. Resolve
      the current LTS at runtime, or vendor the installers.

- [ ] **Nothing keeps the wire format in sync across languages.** The opcodes live twice:
      `packages/protocol/include/glsplay_input.h` for the host and
      `packages/protocol/src/input.ts` for web. The header's `static_assert`s catch C++
      drifting against itself but cannot see the TypeScript. Add a test asserting the TS
      `EVENT_SIZE` table against sizes parsed from the header, before the protocol
      starts changing.

- [ ] **Run `provision.ps1` and `bake-image.ps1` against a real instance.** Both are
      untested end to end. Most likely first failure is the `tools` stage (see pinned
      URLs); second is `nefcon` in `display`, which has never run headless here.

---

## Next phase

- [ ] **Replace the host's scheduled task with a supervisor service.** A Windows service
      in session 0 that calls `WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` →
      `CreateProcessAsUser` to launch the host into the console session, and restarts it
      on crash or session change. This is what Parsec and Sunshine do. The logon-trigger
      task works, but a control plane needs something it can start, stop and query.

- [ ] **Session API.** `POST /sessions` allocates an instance and returns connect
      details; idle timeout tears it down. This is what makes the token work above
      possible, and what turns a VM into a product.

---

## Housekeeping

- [ ] **Resolve the `detailed_prd.md` rename.** It shows deleted with an untracked
      `detailed_prd (old).md` alongside — identical content, CRLF line endings only.
      Either restore it (`git checkout -- detailed_prd.md && rm "detailed_prd (old).md"`)
      or decide it is superseded.
