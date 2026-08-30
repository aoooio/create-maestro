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

import { useMemo, useRef } from "react";

import type { SessionController } from "@/application/session";
import { useTransportPosition } from "@/application/hooks/useTransportPosition";
import { useSessionStore } from "@/application/store/sessionStore";
import { ACCENT_THRESHOLD } from "@/application/voicing";
import { clampNote, noteName } from "@/domain/note";
import { effectiveParameter } from "@/domain/parameter";
import { emptyGrid, resizeGrid } from "@/domain/pattern";
import type { Step } from "@/domain/types";
import { DEFAULT_TRACKS } from "@/infrastructure/audio/voices";
import { Panel } from "@/ui/shared/Panel";

import { CELL_WIDTH_REM, playheadOpacity, playheadTransform } from "./grid";
import { usePatternDraft } from "./usePatternDraft";

/** What a screen reader is told about one cell. A pitched lane has two more
 * things to say about it than a drum lane does. */
function cellLabel(
  label: string,
  index: number,
  step: Step,
  pitched: boolean | undefined,
  transpose: number,
): string {
  const state = step.on ? "actif" : "inactif";
  if (!pitched) return `${label} pas ${index + 1} ${state}`;
  const pitch = noteName(clampNote(step.note + transpose));
  const accent = step.on && step.velocity >= ACCENT_THRESHOLD ? ", accentué" : "";
  return `${label} pas ${index + 1} ${state}, note ${pitch}${accent}`;
}

/** An accented cell and a plain one have to be told apart at a glance, from
 * across a stage. */
const ACCENT_VELOCITY = 1;
const PLAIN_VELOCITY = 0.6;

export function StepSequencer({ controller }: { controller: SessionController | null }) {
  const patterns = useSessionStore((state) => state.patterns);
  const timeline = useSessionStore((state) => state.timeline);
  const params = useSessionStore((state) => state.params);
  const transport = timeline.active;
  const stepCount = transport.beatsPerBar * transport.stepsPerBeat;
  // The note row shows what will sound, so it reads through the same ROOT the
  // voicing applies.
  const transpose = Math.round(Number(effectiveParameter(params, "bassRoot", 0)));

  const playheadRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<HTMLSpanElement>(null);
  const draft = usePatternDraft();

  useTransportPosition(
    controller,
    (frame) => {
      const head = playheadRef.current;
      if (head) {
        // Moved by the real cell pitch (a 1.5rem cell plus a 0.5rem gap), not
        // by a percentage of the container: the row is wider than its cells,
        // so a percentage walks the playhead off the end of the grid.
        head.style.transform = playheadTransform(frame.stepInBar);
        head.style.opacity = playheadOpacity(frame.playing, frame.beatPhase);
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
      const steps = draft.resolve(track.trackId, patterns.get(track.trackId));
      result.set(track.trackId, steps ? resizeGrid(steps, stepCount) : emptyGrid(stepCount));
    }
    return result;
  }, [patterns, draft, stepCount]);

  /**
   * The single write path: every edit — on/off, pitch, accent — goes through
   * it, so they all share the one optimistic draft and the server's word
   * replaces all of them the same way.
   */
  function edit(trackId: string, index: number, change: (step: Step) => Step) {
    const grid = grids.get(trackId);
    if (!grid || !controller) return;
    const next = grid.map((step, i) => (i === index ? change(step) : step));
    draft.commit(trackId, next);
    controller.setPattern(trackId, next);
  }

  const toggle = (trackId: string, index: number) =>
    // The note is deliberately carried over: a cell switched off and back on
    // must return the pitch it had, not a default.
    edit(trackId, index, (step) => ({
      ...step,
      on: !step.on,
      velocity: step.on ? 0 : ACCENT_VELOCITY,
    }));

  const nudgeNote = (trackId: string, index: number, semitones: number) =>
    edit(trackId, index, (step) => ({ ...step, note: clampNote(step.note + semitones) }));

  const toggleAccent = (trackId: string, index: number) =>
    edit(trackId, index, (step) => ({
      ...step,
      velocity: step.velocity >= ACCENT_THRESHOLD ? PLAIN_VELOCITY : ACCENT_VELOCITY,
    }));

  /** Everything the wheel does, reachable from the keyboard — the console has
   * to be playable without a mouse. */
  function onPitchedKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    trackId: string,
    index: number,
  ) {
    const octave = event.shiftKey ? 12 : 1;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      nudgeNote(trackId, index, octave);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      nudgeNote(trackId, index, -octave);
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      toggleAccent(trackId, index);
    }
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
              <div key={track.trackId}>
                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] tracking-wider text-dim">
                    {track.label}
                  </span>
                  {grid.map((step, index) => {
                    const accented = step.on && step.velocity >= ACCENT_THRESHOLD;
                    return (
                      <button
                        key={index}
                        type="button"
                        onClick={() => toggle(track.trackId, index)}
                        onWheel={
                          track.pitched
                            ? (event) =>
                                nudgeNote(
                                  track.trackId,
                                  index,
                                  (event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 12 : 1),
                                )
                            : undefined
                        }
                        onKeyDown={
                          track.pitched
                            ? (event) => onPitchedKey(event, track.trackId, index)
                            : undefined
                        }
                        aria-label={cellLabel(track.label, index, step, track.pitched, transpose)}
                        aria-pressed={step.on}
                        className={`h-8 w-6 shrink-0 text-center text-sm leading-8 transition-none ${
                          step.on ? "glow-strong" : "text-dimmer hover:text-dim"
                        } ${index % transport.stepsPerBeat === 0 ? "border-l border-dimmer" : ""}`}
                      >
                        {step.on ? (accented ? "█" : "▓") : "░"}
                      </button>
                    );
                  })}
                </div>

                {/* The pitches, under the cells they belong to. A pitched lane
                    is unreadable without them: the grid says when, not what. */}
                {track.pitched ? (
                  <div className="flex gap-2 pl-16 text-[10px] text-dimmer tabular-nums">
                    {grid.map((step, index) => (
                      <span key={index} className="w-6 shrink-0 text-center">
                        {step.on ? noteName(clampNote(step.note + transpose)) : "··"}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
