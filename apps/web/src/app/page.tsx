'use client';

import { useEffect, useRef, useState } from 'react';
import { StreamPlayer } from '@/components/StreamPlayer';
import { StatsOverlay } from '@/components/StatsOverlay';
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

  const { state, stream, peerConnection, sendInput, sendControl } = useWebRTC(config);
  const stats = useStreamStats(peerConnection);

  const input = useInputCapture({
    target: videoRef,
    sendInput,
    sendControl,
    enabled: state.connection === 'connected',
  });

  // F1 toggles the HUD. Handled here rather than in useInputCapture because it
  // is a client-side control that must never reach the host.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code !== 'F1') return;
      ev.preventDefault();
      setHudVisible((v) => !v);
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

  return (
    <main ref={mainRef} className="relative h-full w-full bg-void">
      <StreamPlayer
        stream={stream}
        videoRef={videoRef}
        connection={state.connection}
        signaling={state.signaling}
        signalingDetail={state.signalingDetail}
        signalingUrl={config.signalingUrl}
        hostPresent={state.hostPresent}
        pointerLocked={input.pointerLocked}
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

      <div className="absolute bottom-3 right-3 z-10 flex gap-2 font-mono text-[11px]">
        <button
          type="button"
          onClick={() => setHudVisible((v) => !v)}
          className="rounded-md border border-edge bg-panel/90 px-3 py-1.5 text-muted transition-colors hover:text-ink"
        >
          {hudVisible ? 'Hide stats' : 'Stats'}
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="rounded-md border border-edge bg-panel/90 px-3 py-1.5 text-muted transition-colors hover:text-ink"
        >
          {isFullscreen ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>

      {state.signaling === 'error' && (
        <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[10px] text-bad/80">
          signaling: {state.signalingDetail ?? 'error'}
        </div>
      )}
    </main>
  );
}
