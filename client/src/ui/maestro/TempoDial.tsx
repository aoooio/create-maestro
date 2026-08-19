"use client";

/**
 * Transport control. Everything here is scheduled, never immediate: the server
 * lands a change on the next bar, and the console says which bar — a maestro
 * who cannot see when a change will bite has to guess, on stage.
 */

import type { SessionController } from "@/application/session";
import { useSessionStore } from "@/application/store/sessionStore";
import { MAX_BPM, MIN_BPM, beatAt, clampBpm } from "@/domain/transport";
import { positionAt } from "@/domain/musicalTime";
import type { Transport } from "@/domain/types";
import { Panel } from "@/ui/shared/Panel";

export function TempoDial({ controller }: { controller: SessionController | null }) {
  const timeline = useSessionStore((state) => state.timeline);
  const transport = timeline.active;
  const pending = timeline.pending[0];
  const playing = transport.state === "playing";

  const nudge = (delta: number) =>
    controller?.setTransport({ bpm: clampBpm(transport.anchor.bpm + delta) });

  return (
    <Panel
      title="Transport"
      right={pending ? pendingLabel(pending.transport.anchor.bpm, pending.effectiveAtServerMs, timeline.active) : "—"}
    >
      <div className="flex items-center gap-6">
        <button
          type="button"
          onClick={() => controller?.setTransport({ state: playing ? "stopped" : "playing" })}
          className="glow-strong flex h-16 w-24 items-center justify-center border border-current text-lg tracking-widest transition-colors hover:bg-phosphor hover:text-screen-deep"
          aria-label={playing ? "Arrêter" : "Démarrer"}
        >
          {playing ? "■ STOP" : "▶ PLAY"}
        </button>

        <div>
          <div className="flex items-baseline gap-2">
            <span className="glow-strong text-5xl tabular-nums">
              {Math.round(transport.anchor.bpm)}
            </span>
            <span className="text-xs tracking-[0.3em] text-dim">BPM</span>
          </div>
          <div className="mt-2 flex gap-1">
            {[-5, -1, +1, +5].map((delta) => (
              <button
                key={delta}
                type="button"
                onClick={() => nudge(delta)}
                className="glow border border-dimmer px-2 py-1 text-xs tabular-nums transition-colors hover:bg-phosphor hover:text-screen-deep"
              >
                {delta > 0 ? `+${delta}` : delta}
              </button>
            ))}
          </div>
        </div>

        <label className="text-xs text-dim">
          <span className="mb-1 block tracking-[0.2em]">SAISIE</span>
          <input
            type="number"
            min={MIN_BPM}
            max={MAX_BPM}
            defaultValue={Math.round(transport.anchor.bpm)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const value = Number((event.target as HTMLInputElement).value);
              if (Number.isFinite(value)) controller?.setTransport({ bpm: value });
            }}
            className="glow w-20 border border-dimmer bg-transparent px-2 py-1 tabular-nums outline-none"
          />
        </label>

        <div className="text-xs text-dim">
          <span className="mb-1 block tracking-[0.2em]">MESURE</span>
          <span className="glow tabular-nums">
            {transport.beatsPerBar}/{transport.stepsPerBeat === 4 ? 4 : transport.stepsPerBeat}
          </span>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-dimmer">
        ESPACE play/stop · ← → BPM ±1 (±5 avec Maj) · 1/2 solo groupe
      </p>
    </Panel>
  );
}

/** Where a queued change will land, in bars — the reason the queue is visible
 * at all. The bar is computed with the *current* anchor, because that is the
 * tempo still running up to the boundary. */
function pendingLabel(bpm: number, effectiveAtServerMs: number, active: Transport): string {
  const beat = beatAt(active, effectiveAtServerMs);
  const bar = positionAt(beat, active.beatsPerBar, active.stepsPerBeat).bar + 1;
  return `> BPM ${Math.round(bpm)} @ BAR ${bar}`;
}
