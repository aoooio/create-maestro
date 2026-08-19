/** Port of `server/internal/domain/session/musical_time.go`. */

import type { Position } from "./types";

/** The only unit constant the domain needs: every duration derives from BPM. */
const MS_PER_MINUTE = 60000;

export function beatsToMs(beats: number, bpm: number): number {
  return (beats * MS_PER_MINUTE) / bpm;
}

export function msToBeats(ms: number, bpm: number): number {
  return (ms * bpm) / MS_PER_MINUTE;
}

/** Wall duration of one sequencer step. */
export function stepDurationMs(bpm: number, stepsPerBeat: number): number {
  return beatsToMs(1, bpm) / stepsPerBeat;
}

/** Projects an absolute beat onto a bar/beat/step grid. Bars are zero-based. */
export function positionAt(
  beat: number,
  beatsPerBar: number,
  stepsPerBeat: number,
): Position {
  const bars = Math.floor(beat / beatsPerBar);
  const inBar = beat - bars * beatsPerBar;
  return {
    bar: bars,
    beatInBar: Math.floor(inBar),
    stepInBar: Math.floor(inBar * stepsPerBeat),
    beat,
  };
}

export function stepsPerBar(beatsPerBar: number, stepsPerBeat: number): number {
  return beatsPerBar * stepsPerBeat;
}
