'use client';

import { useEffect, useRef, useState } from 'react';
import type { SignalingState } from '@/lib/signaling';
import type { CursorInfo } from '@/hooks/useWebRTC';

export interface StreamPlayerProps {
  stream: MediaStream | null;
  /** Forwarded so input capture can request Pointer Lock on this element. */
  videoRef: React.RefObject<HTMLVideoElement>;
  connection: RTCPeerConnectionState | 'new';
  signaling: SignalingState;
  signalingDetail: string | undefined;
  signalingUrl: string;
  hostPresent: boolean;
  pointerLocked: boolean;
  /** Whether revealed chrome is currently shown. Shared with the page's menu
   *  trigger so every control on the picture fades in and out together. */
  chromeVisible: boolean;
  /** 'relative' = Pointer-Locked mouselook; 'absolute' = desktop pointer. */
  mode: 'relative' | 'absolute';
  /** Remote pointer, drawn client-side. Never baked into the video. */
  cursor: CursorInfo | null;
  /** Host capture size, to place the pointer inside the letterboxed video. */
  captureSize: { w: number; h: number } | null;
  /** Predicted pointer position (host pixels) for the relative-mode sprite. */
  predictedCursor: React.MutableRefObject<{ x: number; y: number }>;
  error: string | null;
}

/** One row of the connection checklist. */
function Stage({
  label,
  state,
  detail,
}: {
  label: string;
  state: 'pending' | 'active' | 'done' | 'failed';
  detail?: string;
}) {
  const mark = { pending: '·', active: '…', done: '✓', failed: '✗' }[state];
  const tone = {
    pending: 'text-muted/50',
    active: 'text-warn',
    done: 'text-good',
    failed: 'text-bad',
  }[state];
  return (
    <div className="flex items-baseline gap-2.5">
      <span className={`w-3 shrink-0 text-center ${tone}`}>{mark}</span>
      <span className={state === 'pending' ? 'text-muted/50' : 'text-ink'}>{label}</span>
      {detail && <span className="truncate text-muted/70">{detail}</span>}
    </div>
  );
}

/**
 * The video surface.
 *
 * Two browser policies shape this component. Autoplay with audio requires a
 * user gesture, so the first frame sits behind an explicit start control.
 * Pointer Lock also requires a gesture, and it is deferred to an explicit
 * "capture mouse" action so desktop use gets a real, zero-latency cursor.
 *
 * The cursor is never in the video (RDP / Parsec / Moonlight model). Two ways
 * to draw it locally:
 *  - absolute mode: as the video's CSS cursor, so the browser renders it at the
 *    true mouse position with zero latency, skinned to the host's shape;
 *  - relative mode: as an <img> overlay at the locally dead-reckoned position,
 *    since Pointer Lock hides the real one.
 */
export function StreamPlayer({
  stream,
  videoRef,
  connection,
  signaling,
  signalingDetail,
  signalingUrl,
  hostPresent,
  pointerLocked,
  chromeVisible,
  mode,
  cursor,
  captureSize,
  predictedCursor,
  error,
}: StreamPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorImgRef = useRef<HTMLImageElement>(null);
  const [started, setStarted] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Cursor shape as a data URL. It is already fully in memory (no network
  // fetch), so it is used directly.
  const cursorUrl = cursor?.url ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream, videoRef]);

  // Skin the browser's own cursor in absolute mode; hide it in relative mode
  // (the game draws its reticle, or we draw the sprite overlay below).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!started) {
      video.style.cursor = '';
      return;
    }
    if (mode === 'relative' || (cursor && !cursor.visible)) {
      video.style.cursor = 'none';
    } else if (cursorUrl) {
      video.style.cursor = `url(${cursorUrl}) ${cursor?.hotspotX ?? 0} ${cursor?.hotspotY ?? 0}, auto`;
    } else {
      // No cursor shape from the host means it is compositing the pointer into
      // the video itself. Showing the browser's arrow as well would put two
      // pointers on screen, one of them a frame of latency behind the other.
      video.style.cursor = 'none';
    }
  }, [started, mode, cursor, cursorUrl, videoRef]);

  // Relative-mode sprite: position it every frame from the predicted position,
  // mapped into the video's letterboxed content box. Imperative rather than
  // React state so it tracks the mouse at display refresh, not render cadence.
  const showSprite = mode === 'relative' && !!cursor?.visible && !!cursorUrl && !!captureSize;
  useEffect(() => {
    if (!showSprite) return;
    const video = videoRef.current;
    if (!video || !captureSize) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const img = cursorImgRef.current;
      if (!img) return;
      const vw = video.clientWidth;
      const vh = video.clientHeight;
      if (!vw || !vh) return;
      const hostAr = captureSize.w / captureSize.h;
      let cw = vw;
      let ch = vw / hostAr;
      if (ch > vh) {
        ch = vh;
        cw = ch * hostAr;
      }
      const ox = (vw - cw) / 2;
      const oy = (vh - ch) / 2;
      const sx = cw / captureSize.w;
      const sy = ch / captureSize.h;
      const p = predictedCursor.current;
      // Keep the sprite inside the rendered video box even if the locally
      // integrated position has drifted past an edge before the next settle.
      const px = Math.min(ox + cw, Math.max(ox, ox + p.x * sx));
      const py = Math.min(oy + ch, Math.max(oy, oy + p.y * sy));
      img.style.transform = `translate(${px}px, ${py}px)`;
      img.style.width = `${(cursor?.width || 32) * sx}px`;
      img.style.height = `${(cursor?.height || 32) * sy}px`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [showSprite, captureSize, cursor?.width, cursor?.height, predictedCursor, videoRef]);

  // Prefer unadjustedMovement: it delivers raw mouse deltas and stops Chrome
  // from moving / re-centring the OS cursor under lock - which otherwise leaks
  // a fixed ~half-window-width jump into movementX ~1x/second. Fall back to a
  // plain lock where the option isn't supported (it rejects without locking).
  const lockPointer = () => {
    const video = videoRef.current;
    if (!video) return;
    video.requestPointerLock({ unadjustedMovement: true }).catch(() => {
      void video.requestPointerLock();
    });
  };

  const start = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      // Unmute here rather than in markup: Chrome blocks an unmuted autoplay
      // before any gesture, and a muted-then-unmuted element is the supported
      // way to get audio on the first play.
      video.muted = false;
      await video.play();
      setStarted(true);
      setPlaybackError(null);
    } catch (err) {
      setPlaybackError(err instanceof Error ? err.message : String(err));
    }
  };

  // Each connection stage is reported separately. Collapsing them into one
  // message makes "never reached the broker" and "broker fine, no host yet"
  // look identical, which is exactly the state you most need to tell apart.
  const brokerState =
    signaling === 'registered' ? 'done'
    : signaling === 'error' ? 'failed'
    : signaling === 'connecting' ? 'active'
    : 'pending';

  const hostState =
    signaling !== 'registered' ? 'pending' : hostPresent ? 'done' : 'active';

  const mediaState =
    connection === 'connected' && stream ? 'done'
    : connection === 'failed' ? 'failed'
    : hostPresent ? 'active'
    : 'pending';

  const headline = (() => {
    if (error) return { text: error, tone: 'text-bad' as const };
    if (signaling === 'error') {
      return { text: 'Cannot reach the signaling broker', tone: 'text-bad' as const };
    }
    if (signaling !== 'registered') {
      return { text: 'Connecting to signaling broker', tone: 'text-warn' as const };
    }
    if (!hostPresent) {
      return { text: 'Waiting for a host to join the room', tone: 'text-warn' as const };
    }
    if (connection === 'failed') {
      return { text: 'Peer connection failed', tone: 'text-bad' as const };
    }
    if (connection === 'disconnected') {
      return { text: 'Reconnecting to host', tone: 'text-warn' as const };
    }
    if (!stream) return { text: 'Host connected, waiting for media', tone: 'text-muted' as const };
    return null;
  })();

  const hint = (() => {
    if (signaling === 'error' || signaling === 'closed') {
      return `Check the broker is running and reachable at ${signalingUrl}`;
    }
    if (signaling !== 'registered') return signalingUrl;
    if (!hostPresent) return 'Start glsplay-host on the VM to begin streaming.';
    if (connection === 'failed') return 'No direct path found - check UDP 50000-50100 on both firewalls.';
    return undefined;
  })();

  const showStartGate = stream !== null && !started;

  // Once the video is actually playing, don't slap a modal over it for a
  // transient signaling reconnect or a brief ICE blip - only for a hard
  // failure or an explicit error.
  const playing = started && stream !== null;
  const showOverlay =
    headline !== null && (!playing || connection === 'failed' || error !== null);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-void">
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        autoPlay
        playsInline
        muted
        // The stream is live and unseekable; native controls would only offer
        // a scrubber that does nothing and a fullscreen button that fights
        // Pointer Lock.
        controls={false}
        disablePictureInPicture
        tabIndex={-1}
      />

      {showSprite && cursorUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={cursorImgRef}
          src={cursorUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute left-0 top-0 z-50 select-none"
          // Parked offscreen until the first rAF tick positions it.
          style={{ willChange: 'transform', transform: 'translate(-9999px, -9999px)' }}
        />
      )}

      {showOverlay && headline && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex w-[340px] flex-col gap-4 rounded-lg border border-edge bg-panel/92 px-6 py-5">
            <div className="flex flex-col gap-1.5">
              <div className={`font-mono text-sm ${headline.tone}`}>{headline.text}</div>
              {hint && <div className="break-all text-xs leading-relaxed text-muted">{hint}</div>}
              {signalingDetail && signaling !== 'registered' && (
                <div className="break-all font-mono text-[11px] text-bad/80">{signalingDetail}</div>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-edge pt-3 font-mono text-[11px]">
              <Stage label="Signaling broker" state={brokerState} />
              <Stage label="Host present" state={hostState} />
              <Stage
                label="Media stream"
                state={mediaState}
                detail={connection !== 'new' ? connection : undefined}
              />
            </div>
          </div>
        </div>
      )}

      {showStartGate && (
        <button
          type="button"
          onClick={() => void start()}
          className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-4 bg-void/70 backdrop-blur-sm transition-colors hover:bg-void/60"
        >
          <div className="rounded-full border border-signal/40 bg-signal/10 px-8 py-4 font-mono text-sm text-signal">
            Click to start
          </div>
          <div className="max-w-xs text-center text-xs leading-relaxed text-muted">
            Starts audio and forwards your mouse and keyboard. Use the pointer
            like a normal desktop; press <kbd className="rounded border border-edge px-1 font-mono">
            Capture mouse
            </kbd>{' '}
            for mouselook games.
          </div>
          {playbackError && <div className="font-mono text-xs text-bad">{playbackError}</div>}
        </button>
      )}

      {started && !pointerLocked && !showOverlay && (
        <button
          type="button"
          onClick={lockPointer}
          className={`absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-md border border-edge bg-panel/90 px-4 py-2 font-mono text-xs text-muted shadow-lg backdrop-blur-sm transition-opacity duration-300 hover:text-ink ${
            chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          Capture mouse (for games) · Esc to release
        </button>
      )}
    </div>
  );
}
