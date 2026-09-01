'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reveals chrome on pointer activity and hides it again once the pointer has
 * been still, the way video players do.
 *
 * A control that is hidden until you hover it cannot be found by hovering: you
 * have to already know it is there. Revealing on any movement over the player
 * and fading out on idle gives the same uncluttered picture while staying
 * discoverable, because the first thing anyone does is move the mouse.
 *
 * `active` exists for Pointer Lock. Locked, mousemove still fires - with
 * relative deltas - so an ungated reveal would flash the trigger continuously
 * through a mouselook session, which is the one moment it must stay out of the
 * way. Pass false whenever the pointer belongs to the host.
 */
export function useIdleReveal(idleMs = 2500, active = true): boolean {
  const [visible, setVisible] = useState(false);
  // Mirrored so the listener can skip the setState on the great majority of
  // moves; a state write per mousemove would re-render the player at pointer
  // sample rate.
  const visibleRef = useRef(false);

  const set = useCallback((next: boolean) => {
    if (visibleRef.current === next) return;
    visibleRef.current = next;
    setVisible(next);
  }, []);

  useEffect(() => {
    if (!active) {
      set(false);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const poke = () => {
      set(true);
      clearTimeout(timer);
      timer = setTimeout(() => set(false), idleMs);
    };

    window.addEventListener('mousemove', poke);
    window.addEventListener('mousedown', poke);
    window.addEventListener('touchstart', poke);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', poke);
      window.removeEventListener('mousedown', poke);
      window.removeEventListener('touchstart', poke);
    };
  }, [active, idleMs, set]);

  return visible;
}
