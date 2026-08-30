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

import { clampNote, midiToFreq } from "@/domain/note";
import { hasActiveStep, stepAt, stepAtIndex } from "@/domain/pattern";
import { LAYER_BASE_NOTE, PENTATONIC_MINOR, groupTrackId } from "@/domain/scale";
import type { GroupId, Pattern, StepEvent } from "@/domain/types";

export interface PlannedNote {
  readonly trackId: string;
  /** Which buffer to play. Absent on a synthesised voice, which has none. */
  readonly sampleId?: string;
  /** 0..1. */
  readonly velocity: number;
  /** Pitched voices only. */
  readonly freq?: number;
  /** How the engine should make the sound. Absent means a sample, which is
   * every voice but the acid bass and the group layers. */
  readonly voice?: "sample" | "acid" | "synth";
  /** Synthesised voices only: an accent, from the step's velocity. */
  readonly accent?: boolean;
  /** Synthesised voices only: how long to hold the note, i.e. one step. */
  readonly durationSec?: number;
  /** Group layer only: whose timbre to build the note with. */
  readonly group?: GroupId;
}

export type Voicing = (event: StepEvent) => readonly PlannedNote[];

/** Reference pitch of the rendered pitched voices (A3). */
export const BASE_FREQ = 220;

/** Minor pentatonic: no interval in it can clash with another, which matters
 * when the players cannot hear each other. The console's note grid is drawn
 * from the same scale, so a written strip and a derived figure sit in one key
 * — which is why it lives in the domain and not here. */
const SCALE = PENTATONIC_MINOR;

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
  group: GroupId;
  /** The maestro's `density` for this group, 0..1. Governs the derived figure
   * only: a written strip is played as written. */
  density: number;
  /**
   * The note strip the maestro has written for this group, if any. It arrives
   * by `pattern.set` on the group's own track, so every phone of the group is
   * reading the same grid — which is what replaces "we all computed the same
   * thing" as the reason two devices agree.
   */
  strip?: Pattern;
  /** Semitones added to every note: the console's ROOT, so the whole room
   * stays in one key. */
  transpose?: number;
  /** Octave offset, so HIGH sits above MID. Derived figure only; a strip
   * carries its own register in the notes the maestro picked. */
  octave?: number;
}

/**
 * The layer a musician's phone plays.
 *
 * Two paths, and the order between them is the whole design. When the maestro
 * has written a strip, it wins: every phone of the group plays the notes on
 * the wire, at the step the shared clock puts them on. When there is none — a
 * fresh session, a group nobody has touched — the original derived figure
 * takes over, so a console left alone still sounds like a piece of music.
 *
 * Both paths are deterministic in the same way: given the same session state
 * and the same step, two phones return the same note. That is what makes "do
 * these two clients agree?" a unit test rather than a rehearsal, and it is why
 * the fallback was not simply deleted.
 */
export function musicianVoicing(options: MusicianVoicingOptions): Voicing {
  const transpose = Math.round(options.transpose ?? 0);
  const trackId = groupTrackId(options.group);

  if (hasActiveStep(options.strip)) {
    const strip = options.strip!;
    return (event: StepEvent) => {
      // Read on the *absolute* step index, not the position in the bar: a
      // strip may be two or four bars long, and folding it onto the bar would
      // silence everything past its first sixteen cells.
      const step = stepAtIndex(strip, event.index);
      if (!step?.on) return [];
      return [
        {
          trackId,
          voice: "synth",
          group: options.group,
          velocity: step.velocity,
          freq: midiToFreq(clampNote(step.note + transpose)),
          accent: step.velocity >= ACCENT_THRESHOLD,
          durationSec: event.secondsPerStep,
        },
      ];
    };
  }

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
        trackId,
        voice: "synth",
        group: options.group,
        // Strong beats a little louder: the bar has to be legible without a
        // drum in the mix on the musician's own phone.
        velocity: event.stepInBar % 4 === 0 ? 0.85 : 0.6,
        freq: midiToFreq(clampNote(LAYER_BASE_NOTE + semitones + transpose)),
        durationSec: event.secondsPerStep,
      },
    ];
  };
}

/**
 * Several layers heard as one. It exists so the maestro can monitor the group
 * layers over the base music without a second code path deciding what a group
 * plays — the console hears exactly the function the phones are running.
 */
export function combineVoicings(...voicings: readonly Voicing[]): Voicing {
  if (voicings.length === 1) return voicings[0]!;
  return (event: StepEvent) => voicings.flatMap((voicing) => voicing(event));
}

export interface TrackBinding {
  readonly trackId: string;
  readonly sampleId: string;
  /** A pitched lane reads the note of each cell and plays the acid voice. */
  readonly pitched?: boolean;
}

/** Above this, a step counts as accented — the 303's one expressive control,
 * and here the only thing a cell's velocity is used for on a pitched track. */
export const ACCENT_THRESHOLD = 0.9;

export interface MaestroVoicingOptions {
  /** Semitones added to every pitched note: the console's ROOT. */
  readonly transpose?: number;
}

/** The maestro's base music: whatever the sequencer grid says. */
export function maestroVoicing(
  patterns: ReadonlyMap<string, Pattern>,
  tracks: readonly TrackBinding[],
  options: MaestroVoicingOptions = {},
): Voicing {
  const transpose = Math.round(options.transpose ?? 0);

  return (event: StepEvent) => {
    const notes: PlannedNote[] = [];
    for (const track of tracks) {
      const pattern = patterns.get(track.trackId);
      if (!pattern) continue;
      const step = stepAt(pattern, event.stepInBar);
      if (!step?.on) continue;
      if (track.pitched) {
        notes.push({
          trackId: track.trackId,
          sampleId: track.sampleId,
          velocity: step.velocity,
          voice: "acid",
          freq: midiToFreq(clampNote(step.note + transpose)),
          accent: step.velocity >= ACCENT_THRESHOLD,
          durationSec: event.secondsPerStep,
        });
        continue;
      }
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
