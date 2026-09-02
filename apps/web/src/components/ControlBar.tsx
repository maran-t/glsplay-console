'use client';

import { EmblemIcon, GripIcon, StatsIcon } from '@/components/icons';

export interface ControlBarProps {
  /** True while the host owns the mouse. The bar removes itself entirely. */
  pointerLocked: boolean;
  /** Whether the quick actions are extended, or slid off the right edge. */
  expanded: boolean;
  onToggleExpanded: () => void;
  hudVisible: boolean;
  onToggleHud: () => void;
  onOpenGuide: () => void;
}

/**
 * Every segment is this wide, so the bar reads as an even run of cells rather
 * than icons at arbitrary intervals - and the collapsed offset can be derived
 * from the grip's width exactly rather than guessed.
 */
const SEGMENT_PX = 54;
/** Icon size. Large enough to carry the cell without filling it. */
const ICON_PX = 18;

/**
 * The docked bar, flush to the right edge.
 *
 * It never fades. A control that disappears on idle has to be rediscovered
 * every time, and on a page whose whole surface is video there is nowhere
 * obvious to go looking - so it stays put, and the user decides how much of it
 * to see.
 *
 * Collapsing translates the whole bar right by its own width less the grip, so
 * the actions travel off the edge of the screen and the grip lands exactly
 * flush against it. The grip is therefore leftmost: it is the one segment that
 * must survive the journey. Nothing is unmounted, so the segments slide rather
 * than blink - they are only taken out of the tab order once off-screen.
 *
 * One colour throughout. The bar sits on live video whose colour is being
 * judged, so an accent here would compete with the picture; state is carried by
 * weight instead, active segments resolving to full ink.
 *
 * Collapsed, it also recedes: a lone grip parked on the edge of a picture is
 * still a foreign object, and holding it at full strength makes it read as
 * something demanding attention rather than something waiting for it. It comes
 * back to full opacity on hover, so reaching for it restores it before the
 * click lands.
 *
 * Under Pointer Lock it is not rendered at all. The browser routes every mouse
 * event to the locked element and hides the cursor, so nothing here could be
 * clicked however it were styled - and a control you can see but cannot press
 * is worse than no control. Press Escape to take the mouse back and it returns.
 * Everything it does stays reachable meanwhile: F1 for the stats overlay, and
 * Escape raises the guide, whose tiles carry the rest.
 */
export function ControlBar({
  pointerLocked,
  expanded,
  onToggleExpanded,
  hudVisible,
  onToggleHud,
  onOpenGuide,
}: ControlBarProps) {
  if (pointerLocked) return null;

  const segment =
    'flex shrink-0 items-center justify-center py-4 text-muted transition-colors hover:bg-void/60 hover:text-ink';
  const hidden = expanded ? undefined : -1;

  return (
    <div
      role="toolbar"
      aria-label="Stream controls"
      style={{
        right: 0,
        borderRadius: '10px 0 0 10px',
        transform: expanded ? undefined : `translateX(calc(100% - ${SEGMENT_PX}px))`,
      }}
      className={`absolute bottom-6 z-30 flex items-stretch overflow-hidden border border-r-0 border-edge bg-panel/90 font-mono shadow-lg backdrop-blur-sm transition-[transform,opacity] duration-300 ease-out ${
        expanded ? 'opacity-100' : 'opacity-50 hover:opacity-100'
      }`}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        title="Quick actions"
        aria-label="Toggle quick actions"
        style={{ width: SEGMENT_PX }}
        className={segment}
      >
        <GripIcon size={ICON_PX} />
      </button>

      <button
        type="button"
        onClick={onOpenGuide}
        tabIndex={hidden}
        title="Session guide (Esc)"
        aria-label="Open session guide"
        style={{ width: SEGMENT_PX }}
        className={segment}
      >
        <EmblemIcon size={ICON_PX} />
      </button>

      <button
        type="button"
        onClick={onToggleHud}
        tabIndex={hidden}
        aria-pressed={hudVisible}
        title="Stats overlay (F1)"
        style={{ width: SEGMENT_PX }}
        className={`${segment} ${hudVisible ? 'text-ink' : ''}`}
      >
        <StatsIcon size={ICON_PX} />
      </button>
    </div>
  );
}
