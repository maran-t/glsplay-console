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
  /** Shown on the connection card - which room this session is waiting on. */
  roomId: string;
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

type HopState = 'pending' | 'active' | 'done' | 'failed';

/**
 * One hop on the connection trace: broker, then host, then media.
 *
 * The three are drawn as a path rather than a checklist because that is what
 * they are - the session is a route, and each hop only exists once the one
 * before it landed. The spine is lit exactly as far as the connection got, so
 * where the colour stops is where the session stopped, which is the one thing
 * you need at a glance when a stream does not start.
 *
 * Failure is a square where the others are round: the trace stays readable
 * without relying on the red.
 */
function Hop({
  label,
  state,
  detail,
  last = false,
}: {
  label: string;
  state: HopState;
  detail?: React.ReactNode;
  last?: boolean;
}) {
  const marker = {
    pending: 'border-edge',
    active: 'border-warn bg-warn/25 hop-active',
    done: 'border-good bg-good',
    failed: 'border-bad bg-bad rounded-[1px]',
  }[state];

  const labelTone = {
    pending: 'text-muted/45',
    active: 'text-ink',
    done: 'text-ink',
    failed: 'text-bad',
  }[state];

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`mt-[3px] h-[9px] w-[9px] shrink-0 rounded-full border ${marker}`}
          aria-hidden
        />
        {!last && <span className={`w-px flex-1 ${state === 'done' ? 'bg-good/40' : 'bg-edge'}`} />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? '' : 'pb-3.5'}`}>
        <div className={`text-[12px] leading-none ${labelTone}`}>{label}</div>
        {detail && (
          <div className="mt-1.5 break-all text-[11px] leading-relaxed text-muted/70">{detail}</div>
        )}
      </div>
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
  roomId,
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

  // A short state for the card header, in the same shape the session guide
  // uses, so the two screens read as one product rather than two.
  const stateWord =
    error ? 'error'
    : signaling === 'error' ? 'no broker'
    : signaling !== 'registered' ? 'connecting'
    : !hostPresent ? 'no host'
    : connection === 'failed' ? 'failed'
    : connection === 'disconnected' ? 'reconnecting'
    : 'negotiating';

  const stateTone =
    error || signaling === 'error' || connection === 'failed' ? 'text-bad' : 'text-warn';

  // Every hop carries its own detail, so nothing is said twice: the header says
  // how it is going, the trace says where it stopped and what to do about it.
  const brokerDetail = (
    <>
      {signalingUrl}
      {(signaling === 'error' || signaling === 'closed') && (
        <span className="mt-1 block text-bad/80">
          Check the broker is running and reachable.
        </span>
      )}
      {signalingDetail && signaling !== 'registered' && (
        <span className="mt-1 block text-bad/70">{signalingDetail}</span>
      )}
    </>
  );

  const hostDetail =
    hostState === 'active' ? 'Start glsplay-host on the VM to begin streaming.' : undefined;

  const mediaDetail =
    mediaState === 'failed' ? 'No direct path found. Open UDP 50000-50100 on both firewalls.'
    : connection !== 'new' ? connection
    : undefined;

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
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="w-[360px] max-w-full rounded-lg border border-edge bg-panel/92 px-6 py-5 font-mono shadow-lg backdrop-blur-sm">
            <div className="mb-5 flex items-baseline gap-3 text-[12px]">
              <span className="font-semibold tracking-wide text-ink">glsplay</span>
              <span className="truncate text-muted">{roomId}</span>
              <span className={`ml-auto shrink-0 ${stateTone}`}>● {stateWord}</span>
            </div>

            {error && (
              <div className="mb-4 break-all text-[11px] leading-relaxed text-bad">{error}</div>
            )}

            <Hop label="Signaling broker" state={brokerState} detail={brokerDetail} />
            <Hop label="Host" state={hostState} detail={hostDetail} />
            <Hop label="Media stream" state={mediaState} detail={mediaDetail} last />
          </div>
        </div>
      )}

      {showStartGate && (
        // The gate is the last hop of the connection trace: everything landed,
        // and the only thing left is the gesture the browser demands before it
        // will play audio. So it holds the same header, and the scrim is light
        // enough to read the first frame through - you can see what you are
        // about to step into, which is also the reassurance that it worked.
        <button
          type="button"
          onClick={() => void start()}
          className="group absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-6 bg-void/55 backdrop-blur-[3px] transition-colors hover:bg-void/45"
        >
          <div className="flex items-baseline gap-3 font-mono text-[12px]">
            <span className="font-semibold tracking-wide text-ink">glsplay</span>
            <span className="truncate text-muted">{roomId}</span>
            <span className="text-good">● ready</span>
          </div>

          <span className="rounded-md bg-signal px-9 py-3.5 font-mono text-sm font-semibold text-void shadow-lg transition-transform duration-150 group-hover:scale-[1.02] group-active:scale-[0.99]">
            Start session
          </span>

          <div className="flex max-w-[19rem] flex-col gap-1.5 text-center text-[11px] leading-relaxed text-muted">
            <span>Turns on sound and sends your mouse and keyboard to the host.</span>
            <span className="text-muted/60">
              The pointer works like a desktop. Mouselook games need Capture mouse.
            </span>
          </div>

          {playbackError && (
            <div className="max-w-[19rem] break-all text-center font-mono text-[11px] leading-relaxed text-bad">
              The browser blocked playback: {playbackError}
            </div>
          )}
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
