/**
 * What sounds at a given step, for each of the two kinds of user.
 *
 * The maestro's answer is easy: read the patterns the console edits. The
 * musician's is the interesting one. `pattern.set` is maestro-only in the
 * protocol (§9.2), so a musician's melody cannot come down the wire — and it
 * must still be *identical* on every phone of a group, or fifty devices in a
 * room turn into fifty soloists.
 *
 * So it is derived: a fixed table plus the shared transport position. Two
 * phones in GROUP 1 compute the same note for the same step because they are
 * reading the same clock, not because anyone told them to. Nothing here
 * touches the DOM or the network, and it is all deterministic — which is what
 * makes "do these two clients agree?" a unit test rather than a rehearsal.
 */

import { stepAt } from "@/domain/pattern";
import type { Pattern, StepEvent } from "@/domain/types";

export interface PlannedNote {
  readonly trackId: string;
  readonly sampleId: string;
  /** 0..1. */
  readonly velocity: number;
  /** Pitched voices only. */
  readonly freq?: number;
}

export type Voicing = (event: StepEvent) => readonly PlannedNote[];

/** Reference pitch of the rendered pitched voices (A3). */
export const BASE_FREQ = 220;

/** Minor pentatonic: no interval in it can clash with another, which matters
 * when the players cannot hear each other. */
const SCALE = [0, 3, 5, 7, 10];

/** Root of each bar, cycling every four bars: i · i · IV · V. */
const PROGRESSION = [0, 0, 5, 7];

/**
 * Per-step gate thresholds over one bar of sixteenths. A step sounds when the
 * maestro's `density` reaches its threshold, so turning the dial up thickens
 * the texture from the strong beats outwards instead of adding notes at
 * random. Identical on every client, which is the whole point.
 */
const GATE = [
  0.05, 0.9, 0.55, 0.8, 0.2, 0.95, 0.5, 0.75, 0.1, 0.85, 0.6, 0.7, 0.25, 0.92, 0.45, 0.65,
];

/** Degree walked by each group, per sixteenth. GROUP 1 climbs, GROUP 2 holds
 * lower and moves half as often: two registers that interlock rather than
 * fight for the same space. */
const FIGURES: Record<number, readonly number[]> = {
  1: [0, 2, 4, 3, 1, 3, 2, 4],
  2: [0, 1, 2, 1],
};

export interface MusicianVoicingOptions {
  group: number;
  /** The maestro's `density` for this group, 0..1. */
  density: number;
  sampleId: string;
  /** Octave offset, so HIGH sits above MID. */
  octave?: number;
}

/**
 * The layer a musician's phone plays. Depends only on the step and the
 * options, so two phones in the same group with the same parameters produce
 * exactly the same sequence.
 */
export function musicianVoicing(options: MusicianVoicingOptions): Voicing {
  const figure = FIGURES[options.group] ?? FIGURES[1]!;
  const octave = options.octave ?? (options.group === 1 ? 1 : 0);

  return (event: StepEvent) => {
    const gate = GATE[event.stepInBar % GATE.length]!;
    if (options.density < gate) return [];

    const degree = figure[Math.abs(event.index) % figure.length]!;
    const root = PROGRESSION[Math.abs(event.bar) % PROGRESSION.length]!;
    const semitones = root + SCALE[degree % SCALE.length]! + 12 * octave;

    return [
      {
        trackId: `group${options.group}`,
        sampleId: options.sampleId,
        // Strong beats a little louder: the bar has to be legible without a
        // drum in the mix on the musician's own phone.
        velocity: event.stepInBar % 4 === 0 ? 0.85 : 0.6,
        freq: BASE_FREQ * 2 ** (semitones / 12),
      },
    ];
  };
}

export interface TrackBinding {
  readonly trackId: string;
  readonly sampleId: string;
}

/** The maestro's base music: whatever the sequencer grid says. */
export function maestroVoicing(
  patterns: ReadonlyMap<string, Pattern>,
  tracks: readonly TrackBinding[],
): Voicing {
  return (event: StepEvent) => {
    const notes: PlannedNote[] = [];
    for (const track of tracks) {
      const pattern = patterns.get(track.trackId);
      if (!pattern) continue;
      const step = stepAt(pattern, event.stepInBar);
      if (!step?.on) continue;
      notes.push({
        trackId: track.trackId,
        sampleId: track.sampleId,
        velocity: step.velocity,
      });
    }
    return notes;
  };
}

/** The one-shot a musician fires from the pad, pitched by how hard they hit. */
export function triggerNote(group: number, intensity: number): PlannedNote {
  const degree = Math.min(SCALE.length - 1, Math.floor(intensity * SCALE.length));
  const octave = group === 1 ? 2 : 1;
  return {
    trackId: `trigger${group}`,
    sampleId: "spark",
    velocity: 0.3 + intensity * 0.7,
    freq: BASE_FREQ * 2 ** ((SCALE[degree]! + 12 * octave) / 12),
  };
}
