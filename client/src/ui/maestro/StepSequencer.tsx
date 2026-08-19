"use client";

/**
 * The maestro's drum machine: tracks down, steps across, and a playhead that
 * moves at 60 fps **without a React render** (§6.2).
 *
 * The playhead is one absolutely positioned column whose `transform` is
 * written directly by the animation frame. Driving it through state would
 * re-render a 6 × 16 grid sixteen times a bar, for the whole set.
 *
 * Edits are optimistic: the cell flips under the finger, and the draft is
 * dropped the moment the server echoes the pattern back with a new generation.
 */

import { useMemo, useRef, useState } from "react";

import type { SessionController } from "@/application/session";
import { useTransportPosition } from "@/application/hooks/useTransportPosition";
import { useSessionStore } from "@/application/store/sessionStore";
import { emptyGrid, resizeGrid } from "@/domain/pattern";
import type { Step } from "@/domain/types";
import { DEFAULT_TRACKS } from "@/infrastructure/audio/voices";
import { Panel } from "@/ui/shared/Panel";

/** Geometry of one step cell, in rem. `w-6` wide, `gap-2` apart — the playhead
 * has to agree with the grid, so both read these. */
const CELL_WIDTH_REM = 1.5;
const CELL_PITCH_REM = 2;

/** A cell flipped locally, and the generation it was flipped against. */
interface Draft {
  steps: Step[];
  basedOnGeneration: number;
}

export function StepSequencer({ controller }: { controller: SessionController | null }) {
  const patterns = useSessionStore((state) => state.patterns);
  const timeline = useSessionStore((state) => state.timeline);
  const transport = timeline.active;
  const stepCount = transport.beatsPerBar * transport.stepsPerBeat;

  const playheadRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<HTMLSpanElement>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());

  useTransportPosition(
    controller,
    (frame) => {
      const head = playheadRef.current;
      if (head) {
        // Moved by the real cell pitch (a 1.5rem cell plus a 0.5rem gap), not
        // by a percentage of the container: the row is wider than its cells,
        // so a percentage walks the playhead off the end of the grid.
        head.style.transform = `translateX(calc(${frame.stepInBar} * ${CELL_PITCH_REM}rem))`;
        // The trace fades across the step, the way a phosphor column would.
        head.style.opacity = frame.playing ? String(0.35 + 0.5 * (1 - frame.beatPhase)) : "0.12";
      }
      const readout = positionRef.current;
      if (readout) {
        readout.textContent = `${String(frame.bar + 1).padStart(3, "0")}.${frame.beatInBar + 1}.${String(frame.stepInBar + 1).padStart(2, "0")}`;
      }
    },
  );

  const grids = useMemo(() => {
    const result = new Map<string, Step[]>();
    for (const track of DEFAULT_TRACKS) {
      const pattern = patterns.get(track.trackId);
      const draft = drafts.get(track.trackId);
      // A draft only survives until the server echoes the track back with a
      // newer generation — at which point the server's word replaces it, with
      // no reconciliation to get wrong (§4.4).
      const live = draft && (pattern?.generation ?? 0) <= draft.basedOnGeneration;
      const steps = live ? draft.steps : (pattern?.steps ?? null);
      result.set(track.trackId, steps ? resizeGrid(steps, stepCount) : emptyGrid(stepCount));
    }
    return result;
  }, [patterns, drafts, stepCount]);

  function toggle(trackId: string, index: number) {
    const grid = grids.get(trackId);
    if (!grid || !controller) return;
    const next = grid.map((step, i) =>
      i === index ? { on: !step.on, velocity: step.on ? 0 : 1 } : step,
    );
    setDrafts((current) => {
      const pruned = new Map<string, Draft>();
      // Drop the drafts the server has already answered, so the map does not
      // grow for the length of a set.
      for (const [id, draft] of current) {
        if ((patterns.get(id)?.generation ?? 0) <= draft.basedOnGeneration) pruned.set(id, draft);
      }
      return pruned.set(trackId, {
        steps: next,
        basedOnGeneration: patterns.get(trackId)?.generation ?? 0,
      });
    });
    controller.setPattern(trackId, next);
  }

  return (
    <Panel
      title="Séquenceur"
      right={
        <span ref={positionRef} className="glow">
          001.1.01
        </span>
      }
    >
      <div className="space-y-1">
        <div className="flex gap-2 pl-16 text-[10px] text-dimmer tabular-nums">
          {Array.from({ length: stepCount }, (_, index) => (
            <span key={index} className="w-6 text-center">
              {index % transport.stepsPerBeat === 0 ? index / transport.stepsPerBeat + 1 : "·"}
            </span>
          ))}
        </div>

        <div className="relative">
          {/* One element, moved by transform — the whole playhead. */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 left-16 bg-phosphor/25"
            style={{ width: `${CELL_WIDTH_REM}rem`, willChange: "transform" }}
            ref={playheadRef}
          />

          {DEFAULT_TRACKS.map((track) => {
            const grid = grids.get(track.trackId) ?? [];
            return (
              <div key={track.trackId} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-[11px] tracking-wider text-dim">
                  {track.label}
                </span>
                {grid.map((step, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => toggle(track.trackId, index)}
                    aria-label={`${track.label} pas ${index + 1} ${step.on ? "actif" : "inactif"}`}
                    aria-pressed={step.on}
                    className={`h-8 w-6 shrink-0 text-center text-sm leading-8 transition-none ${
                      step.on ? "glow-strong" : "text-dimmer hover:text-dim"
                    } ${index % transport.stepsPerBeat === 0 ? "border-l border-dimmer" : ""}`}
                  >
                    {step.on ? "█" : "░"}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
