'use client';

import { useEffect, useRef } from 'react';
import type { HostHelloMessage } from '@glsplay/protocol';
import type { StreamStats } from '@/hooks/useStreamStats';
import {
  FullscreenExitIcon,
  FullscreenIcon,
  MutedIcon,
  PointerIcon,
  QuitIcon,
  SoundIcon,
  StatsIcon,
} from '@/components/icons';

export interface SessionMenuProps {
  open: boolean;
  onClose: () => void;
  roomId: string;
  connection: RTCPeerConnectionState | 'new';
  hello: HostHelloMessage | null;
  stats: StreamStats;
  /** Milliseconds since the peer connection first reached `connected`. */
  connectedMs: number | null;
  muted: boolean;
  onToggleMute: () => void;
  statsVisible: boolean;
  onToggleStats: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onCaptureMouse: () => void;
  bitrateKbps: number;
  onSetBitrate: (kbps: number) => void;
  onDisconnect: () => void;
}

/** Offered bitrates, spanning the PRD section 2 target band and its stretch case. */
const BITRATE_PRESETS = [10_000, 15_000, 25_000, 35_000];

/**
 * One large action tile: icon above, label below. A tile whose state is ON is
 * drawn inverted - light on the dark field - so the row reads at a glance as
 * "which of these is currently active", the way a console guide does it.
 */
function Tile({
  icon,
  label,
  active = false,
  danger = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  const look = danger
    ? 'border-edge bg-panel/90 text-bad hover:border-bad hover:bg-bad hover:text-void'
    : active
      ? 'border-ink bg-ink text-void hover:bg-ink/90'
      : 'border-edge bg-panel/90 text-ink hover:border-ink hover:bg-ink hover:text-void';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-[104px] w-[104px] flex-col items-center justify-center gap-3 rounded-lg border shadow-lg transition-colors ${look}`}
    >
      {icon}
      <span className="px-1 text-center font-mono text-[11px] leading-tight">{label}</span>
    </button>
  );
}

function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`;
}

/**
 * The session guide, opened with Esc or the bar's emblem.
 *
 * No panel. A row of large tiles floats directly on the dimmed stream, the way
 * a console guide interrupts a game: the picture stays visible behind the
 * decision, and every action is one large target with its state readable from
 * across the room. Identity and telemetry sit beneath the row as quiet
 * captions - present because "what am I connected to?" is the question this
 * screen answers, but never competing with the actions.
 *
 * Input capture is suspended while it is open (see `enabled` in page.tsx),
 * because a menu cannot share a keyboard with the game underneath it.
 */
export function SessionMenu({
  open,
  onClose,
  roomId,
  connection,
  hello,
  stats,
  connectedMs,
  muted,
  onToggleMute,
  statsVisible,
  onToggleStats,
  isFullscreen,
  onToggleFullscreen,
  onCaptureMouse,
  bitrateKbps,
  onSetBitrate,
  onDisconnect,
}: SessionMenuProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Focus the first tile on open so the guide is keyboard-navigable however it
  // was raised.
  useEffect(() => {
    if (!open) return;
    rowRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);

  if (!open) return null;

  const live = connection === 'connected';
  const stateLabel =
    connection === 'connected' ? 'live'
    : connection === 'connecting' ? 'connecting'
    : connection === 'failed' ? 'failed'
    : connection === 'disconnected' ? 'dropped'
    : connection;
  const stateTone =
    connection === 'connected' ? 'text-good'
    : connection === 'failed' ? 'text-bad'
    : 'text-warn';

  const liveLine = [
    stats.width !== null && stats.height !== null ? `${stats.width}×${stats.height}` : null,
    stats.fps !== null ? `${stats.fps.toFixed(0)} fps` : null,
    stats.rttMs !== null ? `${stats.rttMs.toFixed(0)} ms rtt` : null,
    hello ? hello.encoder : null,
    hello ? hello.gpu : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-7 bg-void/80 p-6 backdrop-blur-[2px]"
      // Only a press that starts and ends on the backdrop dismisses, so a drag
      // released outside a tile does not close the guide.
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Session guide"
    >
      <div className="flex items-baseline gap-3 font-mono text-[12px]">
        <span className="font-semibold tracking-wide text-ink">glsplay</span>
        <span className="text-muted">{roomId}</span>
        <span className={stateTone}>● {stateLabel}</span>
        {connectedMs !== null && <span className="tnum text-muted">{duration(connectedMs)}</span>}
      </div>

      <div ref={rowRef} className="flex flex-wrap items-center justify-center gap-3">
        <Tile
          icon={muted ? <MutedIcon size={22} /> : <SoundIcon size={22} />}
          label={muted ? 'Muted' : 'Mute'}
          active={muted}
          onClick={onToggleMute}
        />
        <Tile
          icon={<StatsIcon size={22} />}
          label="Stats"
          active={statsVisible}
          onClick={onToggleStats}
        />
        <Tile
          icon={<PointerIcon size={22} />}
          label="Capture mouse"
          onClick={onCaptureMouse}
        />
        <Tile
          icon={isFullscreen ? <FullscreenExitIcon size={22} /> : <FullscreenIcon size={22} />}
          label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          active={isFullscreen}
          onClick={onToggleFullscreen}
        />
        <Tile
          icon={<QuitIcon size={22} />}
          label="Disconnect"
          danger
          onClick={onDisconnect}
        />
      </div>

      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        <span className="text-muted">Bitrate</span>
        {BITRATE_PRESETS.map((kbps) => (
          <button
            key={kbps}
            type="button"
            disabled={!live}
            onClick={() => onSetBitrate(kbps)}
            className={`rounded border px-2 py-0.5 transition-colors disabled:opacity-40 ${
              kbps === bitrateKbps
                ? 'border-signal/50 bg-signal/15 text-signal'
                : 'border-edge text-muted hover:border-ink hover:text-ink'
            }`}
          >
            {kbps / 1000}
          </button>
        ))}
        <span className="text-[10px] text-muted/70">Mbps</span>
      </div>

      <div className="flex flex-col items-center gap-1 font-mono text-[10px] text-muted/70">
        {liveLine && <span className="tnum">{liveLine}</span>}
        <span>
          <kbd className="text-muted">Esc</kbd> closes · <kbd className="text-muted">F1</kbd>{' '}
          stats · click the picture to play
        </span>
      </div>
    </div>
  );
}
