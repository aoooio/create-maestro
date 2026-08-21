"use client";

/**
 * A fader drawn in blocks. It is a range input underneath, so it keeps
 * keyboard control and screen-reader semantics for free.
 */

const FADER_STEPS = 12;

export function Fader({
  label,
  ariaLabel,
  value,
  max = 1,
  format,
  onChange,
}: {
  label: string;
  /** What a screen reader hears, when the printed label is not enough to tell
   * this fader from another one of the same name elsewhere on the console. */
  ariaLabel?: string;
  value: number;
  /** Top of the travel. The readout is a percentage of it. */
  max?: number;
  /** Overrides the readout, for a value that is not a percentage. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const ratio = max === 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * FADER_STEPS);
  return (
    <label className="mb-2 block">
      <span className="mb-1 flex justify-between text-[10px] tracking-[0.2em] text-dim">
        <span>{label}</span>
        <span className="tabular-nums">{format ? format(value) : Math.round(ratio * 100)}</span>
      </span>
      {/* The blocks are the fader; the range input sits invisibly on top of
          them, so dragging lands where it looks like it should and keyboard
          and screen-reader support come for free. */}
      <span className="relative block h-6">
        <span aria-hidden className="glow absolute inset-0 flex items-center text-sm leading-none">
          {"▓".repeat(filled)}
          <span className="text-dimmer">{"░".repeat(FADER_STEPS - filled)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={max}
          step={max / 100}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={ariaLabel ?? label}
        />
      </span>
    </label>
  );
}
