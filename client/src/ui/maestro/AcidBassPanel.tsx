"use client";

/**
 * The bass filter, laid out the way a 303 is: the cutoff and the resonance set
 * where the voice sits, and the envelope controls decide how hard it moves
 * there on every note. ROOT is not a filter control at all — it transposes the
 * line — but it belongs beside them, because it is the other thing the maestro
 * reaches for while the bass is playing.
 */

import type { SessionController } from "@/application/session";
import { useSessionStore } from "@/application/store/sessionStore";
import { NOTE_NAMES } from "@/domain/note";
import { PARAMETER_REGISTRY, effectiveParameter, type ParameterKey } from "@/domain/parameter";
import { Fader } from "@/ui/shared/Fader";
import { Panel } from "@/ui/shared/Panel";

/** The session scope: the acid bass is one instrument, not one per group. */
const ALL = { group: 0 } as const;

const FILTER_KEYS: readonly ParameterKey[] = [
  "bassCutoff",
  "bassResonance",
  "bassEnvMod",
  "bassDecay",
  "bassAccent",
];

export function AcidBassPanel({ controller }: { controller: SessionController | null }) {
  const params = useSessionStore((state) => state.params);
  const root = Math.round(Number(effectiveParameter(params, "bassRoot", 0)));

  const transpose = (delta: number) =>
    // Wraps, so the selector never dead-ends at C or B mid-set.
    controller?.setParameter("bassRoot", (((root + delta) % 12) + 12) % 12, ALL);

  return (
    <Panel title="Basse acide" right={<span className="glow">{NOTE_NAMES[root]}</span>}>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
        {/* A strip of short faders rather than one tall column: the five of
            them are read together, the way they sit on the machine. */}
        <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6">
          {FILTER_KEYS.map((key) => (
            <Fader
              key={key}
              label={PARAMETER_REGISTRY[key].label}
              // CUTOFF and RESO also name the group faders. On screen the
              // panel says which is which; a screen reader has to be told.
              ariaLabel={`BASSE ${PARAMETER_REGISTRY[key].label}`}
              value={Number(effectiveParameter(params, key, 0))}
              onChange={(value) => controller?.setParameter(key, value, ALL)}
            />
          ))}
        </div>

        <div className="shrink-0">
          <span className="mb-1 block text-[10px] tracking-[0.2em] text-dim">ROOT</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => transpose(-1)}
              aria-label="Transposer la basse d’un demi-ton vers le bas"
              className="glow border border-dimmer px-2 py-1 text-xs transition-colors hover:bg-phosphor hover:text-screen-deep"
            >
              ◄
            </button>
            <span className="glow-strong w-10 text-center text-2xl tabular-nums">
              {NOTE_NAMES[root]}
            </span>
            <button
              type="button"
              onClick={() => transpose(+1)}
              aria-label="Transposer la basse d’un demi-ton vers le haut"
              className="glow border border-dimmer px-2 py-1 text-xs transition-colors hover:bg-phosphor hover:text-screen-deep"
            >
              ►
            </button>
          </div>
        </div>
      </div>

      {/* Same place, same voice as the transport's hint line. */}
      <p className="mt-3 text-[11px] text-dimmer">
        ROOT transpose toute la ligne BASS · molette ou ↑ ↓ sur un pas pour sa note (Maj pour
        l’octave) · Maj+Entrée pour l’accent
      </p>
    </Panel>
  );
}
