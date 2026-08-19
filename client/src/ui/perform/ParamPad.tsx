"use client";

/**
 * The single parameter a musician controls (§6.3), drawn as a wireframe strip.
 *
 * It is deliberately local: `param.set` is maestro-only, so nothing here goes
 * on the wire. It moves the timbre inside the range the maestro has opened —
 * the gesture is real, the authority is not borrowed.
 */

import { useRef } from "react";

const CELLS = 24;

export function ParamPad({
  value,
  color,
  onChange,
}: {
  value: number;
  color: string;
  onChange: (value: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function positionToValue(clientX: number): number {
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return value;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  const filled = Math.round(value * CELLS);

  return (
    <div style={{ color }}>
      <div className="mb-1 flex items-baseline justify-between text-[10px] tracking-[0.25em]">
        <span className="text-dim">TIMBRE</span>
        <span className="glow tabular-nums">{Math.round(value * 100)}</span>
      </div>
      <div
        ref={strip}
        role="slider"
        tabIndex={0}
        aria-label="Timbre"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          onChange(positionToValue(event.clientX));
        }}
        onPointerMove={(event) => {
          if (dragging.current) onChange(positionToValue(event.clientX));
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onChange(Math.max(0, value - 0.05));
          if (event.key === "ArrowRight") onChange(Math.min(1, value + 0.05));
        }}
        // 48 px of height, as the touch-target rule asks (§6.3).
        className="no-touch-scroll flex h-12 items-center overflow-hidden border border-current px-2 text-base leading-none"
      >
        <span aria-hidden className="glow whitespace-nowrap">
          {"▮".repeat(filled)}
          <span className="text-dimmer">{"·".repeat(CELLS - filled)}</span>
        </span>
      </div>
    </div>
  );
}
