'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { StreamPlayer } from '@/components/StreamPlayer';
import { StatsOverlay } from '@/components/StatsOverlay';
import { SessionMenu } from '@/components/SessionMenu';
import { ControlBar } from '@/components/ControlBar';
import { useIdleReveal } from '@/hooks/useIdleReveal';
import { useInputCapture } from '@/hooks/useInputCapture';
import { useStreamStats } from '@/hooks/useStreamStats';
import { useWebRTC, type WebRTCConfig } from '@/hooks/useWebRTC';

/** PRD section 2 targets 15-25 Mbps CBR; the ceiling allows the stretch case. */
const DEFAULT_MAX_BITRATE_KBPS = 25_000;

export default function Page() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [hudVisible, setHudVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The bar's quick-action segments; the grip collapses it to one square. */
  const [barExpanded, setBarExpanded] = useState(true);
  const [muted, setMuted] = useState(false);
  /** Set by Disconnect. Starves useWebRTC of a config, which tears the session
   *  down through its existing cleanup rather than a second teardown path. */
  const [ended, setEnded] = useState(false);
  const [bitrateKbps, setBitrateKbps] = useState(DEFAULT_MAX_BITRATE_KBPS);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void mainRef.current?.requestFullscreen();
    }
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const [config, setConfig] = useState<WebRTCConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  // Runtime config first, build-time env second. On a VM booted from an image
  // the room and secret arrive from GCE metadata and are served by
  // /api/session, so the bundle is built once at bake time rather than per
  // session. The NEXT_PUBLIC_ fallback keeps `npm run dev` on a laptop working
  // from nothing but a .env file.
  useEffect(() => {
    let cancelled = false;

    const build = (
      signalingUrl?: string,
      roomId?: string,
      secret?: string,
    ): WebRTCConfig | null => {
      if (!signalingUrl || !roomId || !secret) return null;
      return {
        signalingUrl,
        roomId,
        secret,
        maxBitrateKbps: DEFAULT_MAX_BITRATE_KBPS,
        // STUN only. The host has a public IP, so its host candidate should win
        // outright - a relay would add a hop the latency budget cannot absorb.
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      };
    };

    void (async () => {
      let resolved: WebRTCConfig | null = null;
      try {
        const res = await fetch('/api/session', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as {
            signalingUrl?: string;
            roomId?: string;
            secret?: string;
          };
          resolved = build(body.signalingUrl, body.roomId, body.secret);
        }
      } catch {
        // Served statically, or the route is unreachable - fall through.
      }

      if (!resolved) {
        resolved = build(
          process.env['NEXT_PUBLIC_SIGNALING_URL'],
          process.env['NEXT_PUBLIC_ROOM_ID'],
          process.env['NEXT_PUBLIC_ROOM_SECRET'],
        );
      }

      if (cancelled) return;
      setConfig(resolved);
      setConfigLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const { state, stream, peerConnection, sendInput, sendControl } = useWebRTC(
    ended ? null : config,
  );
  const stats = useStreamStats(peerConnection);

  // Session clock. Stamped once when the peer connection first comes up, and
  // ticked only while the guide is open - nothing else on the page displays it.
  useEffect(() => {
    if (state.connection === 'connected') setConnectedAt((at) => at ?? Date.now());
    else if (state.connection === 'failed' || ended) setConnectedAt(null);
  }, [state.connection, ended]);

  useEffect(() => {
    if (!menuOpen || connectedAt === null) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [menuOpen, connectedAt]);

  const captureSize = useMemo(
    () =>
      state.hello ? { w: state.hello.display.width, h: state.hello.display.height } : null,
    [state.hello],
  );

  const input = useInputCapture({
    target: videoRef,
    sendInput,
    sendControl,
    // Suspended while the guide is open: a menu navigated with the keyboard
    // cannot share a keyboard with the game underneath it.
    enabled: state.connection === 'connected' && !menuOpen,
    captureSize,
    hostCursor: state.cursor,
  });

  // The trigger hides during mouselook - Pointer Lock still emits mousemove, so
  // an ungated reveal would flash it through the whole session.
  const chromeVisible = useIdleReveal(2500, !input.pointerLocked && !menuOpen);

  const captureMouse = () => {
    setMenuOpen(false);
    const video = videoRef.current;
    if (!video) return;
    // Same preference as StreamPlayer: raw deltas, and no OS-cursor re-centring
    // leaking into movementX. Falls back where the option is unsupported.
    video.requestPointerLock({ unadjustedMovement: true }).catch(() => {
      void video.requestPointerLock();
    });
  };

  const setBitrate = (kbps: number) => {
    setBitrateKbps(kbps);
    sendControl({ type: 'set-bitrate', bitrateKbps: kbps });
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  // The video element owns the truth: StreamPlayer unmutes it on the start
  // gesture without going through this state, so re-read it when the guide
  // opens rather than trusting the last toggle.
  useEffect(() => {
    if (menuOpen) setMuted(videoRef.current?.muted ?? false);
  }, [menuOpen]);

  // Client-side keys, handled here rather than in useInputCapture because they
  // must never reach the host.
  //
  // Escape opens the guide because it is the only key that can. Every letter is
  // forwarded to the game while you are playing, so binding one would type into
  // it; Escape is already special-cased as "let me go" and already drops
  // Pointer Lock, so one press releases the mouse and raises the guide - the
  // same gesture a console guide button performs.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === 'F1') {
        ev.preventDefault();
        setHudVisible((v) => !v);
        return;
      }
      if (ev.code === 'Escape') {
        setMenuOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (configLoading) {
    return (
      <main className="flex h-full items-center justify-center p-8">
        <p className="font-mono text-sm text-muted">Loading session…</p>
      </main>
    );
  }

  if (!config) {
    return (
      <main className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-edge bg-panel p-6">
          <h1 className="mb-3 font-mono text-sm text-bad">Configuration missing</h1>
          <p className="mb-4 text-sm leading-relaxed text-muted">
            On a VM these come from instance metadata (
            <code className="font-mono text-ink">glsplay-room</code>,{' '}
            <code className="font-mono text-ink">glsplay-secret</code>) via{' '}
            <code className="font-mono text-ink">/api/session</code> — check{' '}
            <code className="font-mono text-ink">boot.log</code>.
          </p>
          <p className="mb-4 text-sm leading-relaxed text-muted">
            Running locally, copy <code className="font-mono text-ink">.env.example</code> to{' '}
            <code className="font-mono text-ink">.env</code> at the repository root, set the values
            below, and restart the dev server.
          </p>
          <ul className="flex flex-col gap-1 font-mono text-xs text-muted">
            <li>NEXT_PUBLIC_SIGNALING_URL</li>
            <li>NEXT_PUBLIC_ROOM_ID</li>
            <li>NEXT_PUBLIC_ROOM_SECRET</li>
          </ul>
        </div>
      </main>
    );
  }

  // overflow-hidden clips the control bar once it has slid off the right edge;
  // without it the collapsed bar would extend the page.
  return (
    <main ref={mainRef} className="relative h-full w-full overflow-hidden bg-void">
      <StreamPlayer
        stream={stream}
        videoRef={videoRef}
        connection={state.connection}
        signaling={state.signaling}
        signalingDetail={state.signalingDetail}
        signalingUrl={config.signalingUrl}
        hostPresent={state.hostPresent}
        pointerLocked={input.pointerLocked}
        chromeVisible={chromeVisible}
        mode={input.mode}
        cursor={state.cursor}
        captureSize={captureSize}
        predictedCursor={input.predictedCursor}
        error={state.error}
      />

      <StatsOverlay
        stats={stats}
        hostStats={state.hostStats}
        hello={state.hello}
        negotiatedVideo={state.negotiatedVideo}
        pointerLocked={input.pointerLocked}
        gamepads={input.gamepads}
        droppedInput={input.dropped}
        visible={hudVisible}
      />

      <ControlBar
        pointerLocked={input.pointerLocked}
        expanded={barExpanded}
        onToggleExpanded={() => setBarExpanded((v) => !v)}
        hudVisible={hudVisible}
        onToggleHud={() => setHudVisible((v) => !v)}
        onOpenGuide={() => setMenuOpen(true)}
      />

      <SessionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        roomId={config.roomId}
        connection={state.connection}
        hello={state.hello}
        stats={stats}
        connectedMs={connectedAt === null ? null : Math.max(0, nowMs - connectedAt)}
        muted={muted}
        onToggleMute={toggleMute}
        statsVisible={hudVisible}
        onToggleStats={() => setHudVisible((v) => !v)}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onCaptureMouse={captureMouse}
        bitrateKbps={bitrateKbps}
        onSetBitrate={setBitrate}
        onDisconnect={() => {
          setMenuOpen(false);
          setEnded(true);
        }}
      />

      {ended && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-void/90">
          <div className="flex w-[300px] flex-col gap-4 rounded-lg border border-edge bg-panel px-6 py-5 text-center font-mono">
            <div className="text-[13px] text-ink">Session ended</div>
            <div className="text-[11px] leading-relaxed text-muted">
              The host is still running. Reconnecting rejoins the same room.
            </div>
            <button
              type="button"
              onClick={() => setEnded(false)}
              className="rounded-md border border-signal/40 bg-signal/10 px-4 py-2 text-[12px] text-signal transition-colors hover:bg-signal/20"
            >
              Reconnect
            </button>
          </div>
        </div>
      )}

      {state.signaling === 'error' && (
        <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[10px] text-bad/80">
          signaling: {state.signalingDetail ?? 'error'}
        </div>
      )}
    </main>
  );
}
