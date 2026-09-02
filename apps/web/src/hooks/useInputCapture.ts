'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  InputEncoder,
  MouseButton,
  STANDARD_GAMEPAD_MAP,
  WHEEL_DELTA,
  type ClientToHostControl,
  type InputBytes,
} from '@glsplay/protocol';
import type { CursorInfo } from '@/hooks/useWebRTC';

export interface InputCaptureOptions {
  /** Element that receives Pointer Lock and mouse events. Usually the video. */
  target: React.RefObject<HTMLElement>;
  sendInput: (bytes: InputBytes) => boolean;
  sendControl: (msg: ClientToHostControl) => boolean;
  enabled: boolean;
  /** Host capture size. Needed to map an absolute-mode pointer into the
   *  letterboxed video, and to clamp the relative-mode predicted position. */
  captureSize: { w: number; h: number } | null;
  /** Latest host-reported pointer. Used only to correct the predicted position
   *  while in relative mode. */
  hostCursor: CursorInfo | null;
}

export interface InputCaptureState {
  pointerLocked: boolean;
  /** 'relative' while Pointer Lock is held (mouselook); 'absolute' otherwise
   *  (desktop / menu use, where the browser draws the pointer itself). */
  mode: 'relative' | 'absolute';
  gamepads: number;
  /** Events the transport refused, usually from DataChannel backpressure. */
  dropped: number;
  /** Predicted pointer position in host capture pixels, updated synchronously
   *  on every relative move so the client can draw the cursor with zero
   *  latency. Reconciled toward the host position as its updates arrive. Only
   *  meaningful in relative mode. */
  predictedCursor: React.MutableRefObject<{ x: number; y: number }>;
}

/** Chrome deltaMode values. Line and page scrolling need scaling to pixels. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Sanity cap on a single mouse-move delta. A genuine fast flick at a low event
 * rate can still be a few hundred pixels per event, so this is deliberately
 * loose - it only exists to swallow an absurd Pointer Lock glitch value, not to
 * shape normal motion (the first-move-after-lock spike is dropped outright).
 */
const MAX_MOUSE_DELTA = 1200;

/**
 * Spike rejection for relative moves. Chrome's Pointer Lock, in its default
 * "adjusted" mode, periodically warps the OS cursor back toward the centre of
 * the locked element and leaks that warp into movementX/Y as a fixed jump of
 * roughly half the window width (~1x/second, often a doubled pulse). Requesting
 * unadjustedMovement stops the warp at the source; this is the backstop. A
 * genuine flick ramps up - it never jumps to many times the recent average in
 * one 1-2 ms sample - so an event that is both large in absolute terms and far
 * above the running average is that warp, and is dropped whole.
 */
const SPIKE_ABS_PX = 120;
const SPIKE_EMA_MULT = 8;

/**
 * How long after the last relative move the pointer is considered "at rest".
 * While moving, the locally integrated position is authoritative and shown as
 * is - it tracks the hand exactly and needs no correction. Once the mouse has
 * been still this long, the host's reported position (which lags by the
 * network) has caught up and is copied verbatim, silently absorbing any drift
 * from a clamp edge or a game warp. No distance thresholds, nothing tied to
 * resolution - just "trust local while moving, trust host once stopped".
 */
const CURSOR_SETTLE_MS = 120;

/**
 * Captures mouse, keyboard and gamepad, and packs them onto the input
 * DataChannel (PRD section 4.4).
 *
 * Two pointer modes, the way Parsec / Moonlight / RDP do it:
 *  - absolute (default): not Pointer-Locked. The browser draws the real cursor
 *    over the video with zero latency; we send its position, mapped into the
 *    host's captured output. The host streams the cursor *shape* so the local
 *    pointer is skinned to look like the remote one.
 *  - relative: Pointer Lock is held for mouselook. We send raw deltas; the game
 *    owns the on-screen reticle. If the host still reports a visible pointer
 *    (a software cursor, a menu), the client draws it from a locally
 *    dead-reckoned position and reconciles to the host's.
 *
 * Events are encoded and flushed on a microtask rather than on
 * requestAnimationFrame. Batching to the frame would be kinder to SCTP, but it
 * adds up to a full frame of latency to every input - which is most of the 1ms
 * that PRD section 5 budgets for the entire input stage.
 */
export function useInputCapture(opts: InputCaptureOptions): InputCaptureState {
  const { target, sendInput, sendControl, enabled, captureSize, hostCursor } = opts;

  const [pointerLocked, setPointerLocked] = useState(false);
  const [gamepads, setGamepads] = useState(0);
  const [dropped, setDropped] = useState(0);

  const encoderRef = useRef(new InputEncoder(4096));
  const flushScheduled = useRef(false);
  const droppedRef = useRef(0);
  /** Keys currently held, so they can be released on focus loss. */
  const heldKeys = useRef(new Set<string>());
  /** Mouse buttons currently held, released on focus loss so a drag that ends
   *  outside the video can't latch a button down on the host. */
  const heldButtons = useRef(new Set<number>());
  /** Last gamepad payload per index, to suppress duplicate frames. */
  const lastPad = useRef(new Map<number, string>());
  /** Set when Pointer Lock engages; the first mousemove after it carries a
   *  bogus jump from the previous OS cursor position and is dropped. */
  const swallowNextMove = useRef(false);
  const startRef = useRef(0);

  /**
   * True once the user has engaged the stream - clicked into the video or taken
   * Pointer Lock. Keyboard is only forwarded while this holds, so keystrokes
   * meant for the surrounding page don't leak to the host. Cleared on blur or
   * Escape.
   */
  const activeRef = useRef(false);
  /** Props mirrored into refs so the event handlers don't need re-binding. */
  const captureSizeRef = useRef(captureSize);
  const hostCursorRef = useRef(hostCursor);
  /** Locally integrated pointer position, host capture pixels. */
  const predictedCursor = useRef({ x: 0, y: 0 });
  /** performance.now() of the last relative move, for the settle check. */
  const lastMoveAtRef = useRef(0);
  /** EMA of recent relative-move magnitude, for spike rejection. */
  const moveMagEmaRef = useRef(0);
  /** Last pointer position over the video in CSS pixels, for desktop-mode
   *  delta derivation. Null until the pointer enters, so re-entering after a
   *  trip outside the element seeds rather than injects a jump. */
  const lastDesktopPos = useRef<{ x: number; y: number } | null>(null);
  /** Sub-pixel remainder carried between desktop-mode moves. Without it, slow
   *  motion truncates to zero on every event and the pointer never starts. */
  const desktopRemainder = useRef({ x: 0, y: 0 });

  useEffect(() => {
    captureSizeRef.current = captureSize;
  }, [captureSize]);
  useEffect(() => {
    hostCursorRef.current = hostCursor;
  }, [hostCursor]);

  if (startRef.current === 0 && typeof performance !== 'undefined') {
    startRef.current = performance.now();
  }

  /** Client clock in ms since capture began; fits the u32 wire field. */
  const now = useCallback((): number => {
    return Math.round(performance.now() - startRef.current) >>> 0;
  }, []);

  const flush = useCallback(() => {
    flushScheduled.current = false;
    const encoder = encoderRef.current;
    if (encoder.byteLength === 0) return;
    if (!sendInput(encoder.bytes())) {
      droppedRef.current += 1;
      setDropped(droppedRef.current);
    }
    encoder.reset();
  }, [sendInput]);

  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(flush);
  }, [flush]);

  /** Releases every held key. Called when focus or pointer lock is lost. */
  const releaseHeldKeys = useCallback(() => {
    if (heldKeys.current.size === 0) return;
    const encoder = encoderRef.current;
    const t = now();
    for (const code of heldKeys.current) {
      if (!encoder.key(code, false, t)) {
        flush();
        encoder.key(code, false, t);
      }
    }
    heldKeys.current.clear();
    scheduleFlush();
  }, [flush, now, scheduleFlush]);

  /** Releases every held mouse button. */
  const releaseHeldButtons = useCallback(() => {
    if (heldButtons.current.size === 0) return;
    const encoder = encoderRef.current;
    const t = now();
    for (const button of heldButtons.current) {
      if (!encoder.mouseButton(button, false, t)) {
        flush();
        encoder.mouseButton(button, false, t);
      }
    }
    heldButtons.current.clear();
    scheduleFlush();
  }, [flush, now, scheduleFlush]);

  /**
   * Rendered size of the video's content box - the letterboxed area that
   * actually shows host pixels, excluding the bars. Null while the size isn't
   * known yet.
   */
  const contentSize = useCallback((): { cw: number; ch: number } | null => {
    const el = target.current;
    const cap = captureSizeRef.current;
    if (!el || !cap || cap.w <= 0 || cap.h <= 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const hostAr = cap.w / cap.h;
    let cw = rect.width;
    let ch = cw / hostAr;
    if (ch > rect.height) {
      ch = rect.height;
      cw = ch * hostAr;
    }
    return { cw, ch };
  }, [target]);

  // Switching capture off matters as much as losing focus: a key held at that
  // moment has no keyup coming, and stays down on the remote desktop. The
  // session guide suspends capture while it is open, so this is the ordinary
  // path, not an edge case.
  useEffect(() => {
    if (enabled) return;
    activeRef.current = false;
    releaseHeldKeys();
    releaseHeldButtons();
  }, [enabled, releaseHeldButtons, releaseHeldKeys]);

  // ---- pointer lock ------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === target.current;
      setPointerLocked(locked);
      // Either direction leaves the desktop-mode origin stale - the pointer is
      // warped by the lock transition itself.
      lastDesktopPos.current = null;
      desktopRemainder.current = { x: 0, y: 0 };
      if (locked) {
        swallowNextMove.current = true;
        activeRef.current = true;
        // Start from wherever the host says the pointer is. If it hasn't
        // reported yet, start at the origin; the first settle copies the real
        // position in within CURSOR_SETTLE_MS.
        const hc = hostCursorRef.current;
        predictedCursor.current = hc ? { x: hc.x, y: hc.y } : { x: 0, y: 0 };
        lastMoveAtRef.current = 0;
      }
      sendControl({ type: 'set-pointer-mode', mode: locked ? 'relative' : 'absolute' });
      // Leaving lock mid-keypress would otherwise latch that key down on the
      // remote desktop with no matching keyup ever arriving.
      if (!locked) releaseHeldKeys();
    };

    document.addEventListener('pointerlockchange', onPointerLockChange);
    return () => document.removeEventListener('pointerlockchange', onPointerLockChange);
  }, [enabled, releaseHeldKeys, sendControl, target]);

  // ---- re-sync to the host position once the pointer is at rest ----------
  useEffect(() => {
    if (!hostCursor) return;
    // Absolute mode draws the browser's own cursor, so this is unused.
    if (document.pointerLockElement !== target.current) return;
    // While the mouse is moving, the locally integrated position is shown as
    // is - correcting toward the network-delayed host position mid-motion is
    // what makes the pointer stutter and jump. Only once it has settled do we
    // copy the host position in, absorbing any drift where it can't be seen.
    if (performance.now() - lastMoveAtRef.current < CURSOR_SETTLE_MS) return;
    predictedCursor.current = { x: hostCursor.x, y: hostCursor.y };
  }, [hostCursor, target]);

  // ---- mouse -----------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    const element = target.current;
    if (!element) return;

    const buttonFor = (raw: number): number | null => {
      switch (raw) {
        case 0: return MouseButton.Left;
        case 1: return MouseButton.Middle;
        case 2: return MouseButton.Right;
        case 3: return MouseButton.Back;
        case 4: return MouseButton.Forward;
        default: return null;
      }
    };

    /**
     * Desktop-mode (not Pointer-Locked) motion, sent as a delta rather than an
     * absolute position.
     *
     * The obvious encoding - normalise the position over the captured monitor
     * and send mouseMoveAbsolute - is wrong against this host. It injects with
     * MOUSEEVENTF_VIRTUALDESK, whose 0..65535 range spans the whole virtual
     * desktop; the VM's captured display is only part of that (the L4's
     * phantom head is the rest), so the pointer lands scaled by
     * virtualWidth/captureWidth and offset by the capture origin - it runs
     * ahead of the local cursor and the hover highlight sits somewhere else.
     *
     * Deltas take the host's relative path instead, which injects 1:1 and
     * clamps to the captured monitor. Scaling rendered CSS pixels into capture
     * pixels means a sweep across the video covers exactly the same fraction
     * of the host's screen however large the video is drawn, and both pointers
     * reach their left/right limits together, so they cannot drift apart.
     */
    const sendDesktopMotion = (ev: MouseEvent) => {
      const cap = captureSizeRef.current;
      const box = contentSize();
      const prev = lastDesktopPos.current;
      lastDesktopPos.current = { x: ev.clientX, y: ev.clientY };
      // The first sample after entering the video only seeds the origin -
      // treating it as motion would inject the jump from wherever the pointer
      // was last seen.
      if (!cap || !box || !prev) return;
      const rx = (ev.clientX - prev.x) * (cap.w / box.cw) + desktopRemainder.current.x;
      const ry = (ev.clientY - prev.y) * (cap.h / box.ch) + desktopRemainder.current.y;
      let dx = Math.trunc(rx);
      let dy = Math.trunc(ry);
      desktopRemainder.current = { x: rx - dx, y: ry - dy };
      if (dx === 0 && dy === 0) return;
      dx = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dx));
      dy = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dy));
      const encoder = encoderRef.current;
      if (!encoder.mouseMoveRelative(dx, dy, now())) {
        flush();
        encoder.mouseMoveRelative(dx, dy, now());
      }
      scheduleFlush();
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (document.pointerLockElement === element) {
        // The first event after Pointer Lock engages reports the delta from the
        // pre-lock cursor position - often hundreds of pixels. Drop it whole.
        if (swallowNextMove.current) {
          swallowNextMove.current = false;
          return;
        }
        // Use the event's own movementX/Y. getCoalescedEvents() was tried here,
        // but its per-sample movement deltas are unreliable under Pointer Lock
        // in Chrome (sometimes cumulative, sometimes zero) and summing them made
        // the remote pointer shake. One reliable delta per event is smoother.
        let dx = ev.movementX;
        let dy = ev.movementY;
        if (dx === 0 && dy === 0) return;
        // Reject Chrome's Pointer Lock re-centre warp: a single event both large
        // in absolute terms and far above the running average. Don't send it,
        // don't integrate it, and don't let it move the average.
        const mag = Math.hypot(dx, dy);
        const ema = moveMagEmaRef.current;
        // Parked. unadjustedMovement already stops the warp at the source, so
        // this only ever fires on a genuine fast flick - which it then discards
        // whole, so the host never sees that motion and the aim sticks. The
        // average is still tracked below, so restoring it is one uncomment.
        // if (mag > SPIKE_ABS_PX && mag > ema * SPIKE_EMA_MULT) return;
        moveMagEmaRef.current = ema * 0.9 + mag * 0.1;
        dx = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dx));
        dy = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dy));
        // Integrate the delta locally so the cursor tracks the hand with no
        // round trip. The host injects these same deltas 1:1 (acceleration is
        // disabled there), so this stays in step with the real host pointer;
        // any drift is corrected on settle. Clamped to the capture because the
        // host clamps the real pointer the same way - letting this run free
        // past an edge banks up motion that has to be undone before the sprite
        // moves again, which reads as the pointer sticking.
        const p = predictedCursor.current;
        const cap = captureSizeRef.current;
        predictedCursor.current = {
          x: cap ? Math.min(cap.w, Math.max(0, p.x + dx)) : p.x + dx,
          y: cap ? Math.min(cap.h, Math.max(0, p.y + dy)) : p.y + dy,
        };
        lastMoveAtRef.current = performance.now();
        const encoder = encoderRef.current;
        if (!encoder.mouseMoveRelative(dx, dy, now())) {
          flush();
          encoder.mouseMoveRelative(dx, dy, now());
        }
        scheduleFlush();
        return;
      }
      sendDesktopMotion(ev);
    };

    // Leaving the element drops the origin, so coming back in seeds afresh
    // instead of injecting the whole trip across the page as one delta.
    const onMouseLeave = () => {
      lastDesktopPos.current = null;
      desktopRemainder.current = { x: 0, y: 0 };
    };

    const onMouseDown = (ev: MouseEvent) => {
      activeRef.current = true;
      const button = buttonFor(ev.button);
      if (button === null) return;
      ev.preventDefault();
      // Flush any motion still held in the sub-pixel remainder so the click
      // lands where the pointer visibly is, not one event behind.
      if (document.pointerLockElement !== element) sendDesktopMotion(ev);
      heldButtons.current.add(button);
      encoderRef.current.mouseButton(button, true, now());
      scheduleFlush();
    };

    const onMouseUp = (ev: MouseEvent) => {
      const button = buttonFor(ev.button);
      if (button === null) return;
      if (!heldButtons.current.delete(button)) return;
      ev.preventDefault();
      encoderRef.current.mouseButton(button, false, now());
      scheduleFlush();
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      // Normalise to pixels, then to Win32 wheel notches. Chrome reports lines
      // on some platforms and pages when a scroll region is paged.
      const scale =
        ev.deltaMode === DOM_DELTA_LINE ? 16 : ev.deltaMode === DOM_DELTA_PAGE ? 100 : 1;
      const vertical = Math.round((-ev.deltaY * scale * WHEEL_DELTA) / 100);
      const horizontal = Math.round((ev.deltaX * scale * WHEEL_DELTA) / 100);
      if (vertical === 0 && horizontal === 0) return;
      encoderRef.current.mouseWheel(vertical, horizontal, now());
      scheduleFlush();
    };

    // The browser context menu would steal a right-click that belongs to the
    // game, so it is suppressed for the viewport only.
    const onContextMenu = (ev: Event) => ev.preventDefault();

    // A click anywhere outside the video releases keyboard capture, so the
    // page's own controls (stats, full screen) behave normally. This runs in
    // the capture phase, before the element's own mousedown re-arms it.
    const onDocMouseDown = (ev: MouseEvent) => {
      if (ev.target instanceof Node && element.contains(ev.target)) return;
      activeRef.current = false;
      releaseHeldKeys();
      releaseHeldButtons();
    };

    element.addEventListener('mousemove', onMouseMove);
    element.addEventListener('mouseleave', onMouseLeave);
    element.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousedown', onDocMouseDown, { capture: true });
    window.addEventListener('mouseup', onMouseUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', onContextMenu);

    return () => {
      element.removeEventListener('mousemove', onMouseMove);
      element.removeEventListener('mouseleave', onMouseLeave);
      element.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousedown', onDocMouseDown, { capture: true });
      window.removeEventListener('mouseup', onMouseUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
    };
  }, [enabled, flush, now, releaseHeldButtons, releaseHeldKeys, scheduleFlush, target, contentSize]);

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (ev: KeyboardEvent) => {
      if (!activeRef.current) return;
      // Escape is the universal "let me go" - it exits Pointer Lock (the browser
      // handles that) and, in absolute mode, releases keyboard focus. Never
      // forwarded, or it would also pause the game.
      if (ev.code === 'Escape') {
        activeRef.current = false;
        releaseHeldKeys();
        return;
      }
      ev.preventDefault();
      // Ignore auto-repeat. Games derive their own repeat from held state, and
      // the OS repeat rate on the host is what should govern text fields.
      if (ev.repeat) return;
      if (encoderRef.current.key(ev.code, true, now())) {
        heldKeys.current.add(ev.code);
        scheduleFlush();
      }
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (ev.code === 'Escape') return;
      ev.preventDefault();
      if (encoderRef.current.key(ev.code, false, now())) {
        heldKeys.current.delete(ev.code);
        scheduleFlush();
      }
    };

    // Alt-tabbing away while holding W would leave the character walking
    // forever on the host.
    const onBlur = () => {
      activeRef.current = false;
      releaseHeldKeys();
      releaseHeldButtons();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled, now, releaseHeldButtons, releaseHeldKeys, scheduleFlush]);

  // ---- gamepad -------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator.getGamepads !== 'function') return;

    let frame = 0;

    /** Maps the W3C -1..1 axis range onto the XInput signed 16-bit range. */
    const axis = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 32767);

    const poll = () => {
      frame = requestAnimationFrame(poll);

      const pads = navigator.getGamepads();
      let connected = 0;
      const encoder = encoderRef.current;
      const t = now();

      for (let i = 0; i < pads.length && i < 4; i += 1) {
        const pad = pads[i];
        if (!pad?.connected) {
          if (lastPad.current.delete(i)) {
            encoder.gamepadConnection(i, false, t);
            scheduleFlush();
          }
          continue;
        }
        connected += 1;

        let buttons = 0;
        for (let b = 0; b < pad.buttons.length && b < STANDARD_GAMEPAD_MAP.length; b += 1) {
          if (pad.buttons[b]?.pressed) buttons |= STANDARD_GAMEPAD_MAP[b] ?? 0;
        }
        const lt = Math.round((pad.buttons[6]?.value ?? 0) * 255);
        const rt = Math.round((pad.buttons[7]?.value ?? 0) * 255);
        // Y axes are inverted relative to XInput, which treats up as positive.
        const lx = axis(pad.axes[0] ?? 0);
        const ly = -axis(pad.axes[1] ?? 0);
        const rx = axis(pad.axes[2] ?? 0);
        const ry = -axis(pad.axes[3] ?? 0);

        const signature = `${buttons}|${lt}|${rt}|${lx}|${ly}|${rx}|${ry}`;
        const previous = lastPad.current.get(i);
        if (previous === undefined) encoder.gamepadConnection(i, true, t);
        // Resending an unchanged pad state every frame would be 60 wasted
        // packets a second per controller.
        if (previous === signature) continue;

        lastPad.current.set(i, signature);
        if (!encoder.gamepad(i, buttons, lt, rt, lx, ly, rx, ry, t)) {
          flush();
          encoder.gamepad(i, buttons, lt, rt, lx, ly, rx, ry, t);
        }
        scheduleFlush();
      }

      setGamepads((prev) => (prev === connected ? prev : connected));
    };

    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, [enabled, flush, now, scheduleFlush]);

  return {
    pointerLocked,
    mode: pointerLocked ? 'relative' : 'absolute',
    gamepads,
    dropped,
    predictedCursor,
  };
}
