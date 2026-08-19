"use client";

/**
 * The play surface. A tap fires a trigger; dragging across it keeps firing,
 * with an intensity taken from how fast the finger is moving — which is the
 * closest a touchscreen gets to how hard someone hit something.
 *
 * `touch-action: none` is not a detail: without it the browser treats a drag
 * as a scroll and swallows the pointer events halfway through a gesture.
 */

import { useRef } from "react";

/** Fastest re-trigger while dragging. Below this the pad becomes a machine gun
 * and the rate limiter starts dropping messages. */
const RETRIGGER_MS = 130;
/** Speed, in px/ms, that counts as a full-intensity gesture. */
const FULL_SPEED = 2.2;

export function PadZone({
  color,
  onTrigger,
}: {
  color: string;
  onTrigger: (intensity: number) => void;
}) {
  const surface = useRef<HTMLButtonElement>(null);
  const last = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastFire = useRef(0);
  const flash = useRef<HTMLSpanElement>(null);

  function fire(intensity: number) {
    lastFire.current = performance.now();
    onTrigger(intensity);
    const element = flash.current;
    if (element) {
      // Feedback written straight to the DOM: at this rate, state would be
      // several renders a second for a purely visual flash.
      element.style.opacity = String(0.25 + intensity * 0.75);
      requestAnimationFrame(() => {
        if (flash.current) flash.current.style.opacity = "0";
      });
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    last.current = { x: event.clientX, y: event.clientY, t: performance.now() };
    // A clean tap has no speed to measure; pressure when the device reports it,
    // a firm default otherwise.
    fire(event.pressure > 0 && event.pressure < 1 ? event.pressure : 0.75);
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const previous = last.current;
    if (!previous) return;
    const now = performance.now();
    const elapsed = Math.max(1, now - previous.t);
    const distance = Math.hypot(event.clientX - previous.x, event.clientY - previous.y);
    last.current = { x: event.clientX, y: event.clientY, t: now };

    if (now - lastFire.current < RETRIGGER_MS) return;
    const speed = distance / elapsed;
    if (speed < 0.15) return;
    fire(Math.min(1, speed / FULL_SPEED));
  }

  function onPointerUp() {
    last.current = null;
  }

  return (
    <button
      ref={surface}
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="Zone de jeu — appuyez pour déclencher"
      className="no-touch-scroll relative block min-h-40 w-full flex-1 border border-current"
      style={{ color }}
    >
      <span
        ref={flash}
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-current opacity-0 transition-opacity duration-200"
      />
      <span className="glow relative text-sm tracking-[0.3em] uppercase">frappez</span>
    </button>
  );
}
