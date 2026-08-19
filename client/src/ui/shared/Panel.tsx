"use client";

/** A framed region of the screen, titled the way a terminal frames one: the
 * heading sits in the rule itself. */
export function Panel({
  title,
  right,
  children,
  className = "",
  color,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Overrides the phosphor, e.g. to tint a panel with a group's colour. */
  color?: string;
}) {
  return (
    <section
      className={`relative border border-dimmer bg-screen/60 ${className}`}
      style={color ? { color, borderColor: color } : undefined}
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-dimmer px-3 py-1.5">
        <h2 className="glow text-xs tracking-[0.2em] uppercase">{title}</h2>
        {right ? <div className="text-[11px] text-dim tabular-nums">{right}</div> : null}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** `[████░░░░]` — a progress bar drawn in characters, so it reads at a glance
 * on a phone held at arm's length. */
export function Meter({
  value,
  width = 20,
  label,
}: {
  value: number;
  width?: number;
  label?: string;
}) {
  const ratio = Math.min(1, Math.max(0, value));
  const filled = Math.round(ratio * width);
  return (
    <div className="flex items-center gap-2 tabular-nums">
      <span className="glow" aria-hidden>
        [{"█".repeat(filled)}
        {"░".repeat(width - filled)}]
      </span>
      <span className="sr-only">{Math.round(ratio * 100)}%</span>
      {label ? <span className="text-dim text-xs">{label}</span> : null}
    </div>
  );
}

/** The blinking block that says a terminal is waiting for you. */
export function Cursor() {
  return (
    <span aria-hidden className="animate-blink glow">
      ▮
    </span>
  );
}
