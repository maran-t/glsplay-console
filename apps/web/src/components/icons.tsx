/**
 * The whole icon set, hand-drawn as strokes on currentColor over one 14-unit
 * grid. Nine glyphs do not justify an icon dependency, and drawing them here
 * keeps every stroke weight consistent with the 1px hairlines the rest of the
 * chrome is built from. `size` scales the drawing; the bar uses them at 14,
 * the guide tiles at 22.
 */

interface IconProps {
  size?: number;
}

function props(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const;
}

/** Six dots - the drag/toggle grip, the one glyph kept from console overlays. */
export function GripIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)} stroke="none" fill="currentColor">
      <circle cx="4.7" cy="3" r="1.1" />
      <circle cx="9.3" cy="3" r="1.1" />
      <circle cx="4.7" cy="7" r="1.1" />
      <circle cx="9.3" cy="7" r="1.1" />
      <circle cx="4.7" cy="11" r="1.1" />
      <circle cx="9.3" cy="11" r="1.1" />
    </svg>
  );
}

/**
 * The glsplay mark: a play wedge drawn as three separate strokes, open at every
 * corner. Solid triangles are the default play glyph everywhere; leaving the
 * corners unclosed makes it read as a mark rather than a transport control,
 * which is what it is here - it opens the guide, it does not start anything.
 */
export function EmblemIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M3.9 4.1v5.8" />
      <path d="M4.9 3.2l5.9 3.3" />
      <path d="M10.8 7.5l-5.9 3.3" />
    </svg>
  );
}

export function StatsIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M2.5 11.5V7.5M7 11.5v-9M11.5 11.5v-6" />
    </svg>
  );
}

export function FullscreenIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M5.5 2.5h-3v3M8.5 2.5h3v3M5.5 11.5h-3v-3M8.5 11.5h3v-3" />
    </svg>
  );
}

export function FullscreenExitIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M2.5 5.5h3v-3M11.5 5.5h-3v-3M2.5 8.5h3v3M11.5 8.5h-3v3" />
    </svg>
  );
}

export function PointerIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M3 2.2l8 3.4-3.6 1.2L6 10.6 3 2.2z" />
    </svg>
  );
}

export function SoundIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M2.5 5.5v3h2l3 2.5v-8l-3 2.5h-2z" />
      <path d="M10 4.5a3.6 3.6 0 0 1 0 5" />
    </svg>
  );
}

export function MutedIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M2.5 5.5v3h2l3 2.5v-8l-3 2.5h-2z" />
      <path d="M9.5 5.5l3 3M12.5 5.5l-3 3" />
    </svg>
  );
}

/** Quit. An X rather than a power glyph, matching what it does: leave, not power off the host. */
export function QuitIcon({ size = 14 }: IconProps) {
  return (
    <svg {...props(size)}>
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
    </svg>
  );
}
