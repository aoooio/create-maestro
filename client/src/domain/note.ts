/**
 * Pitch, as MIDI note numbers.
 *
 * The musician layer works in *offsets* from a fixed root (`voicing.ts`) —
 * that is what lets two phones agree without being told anything. The maestro's
 * pitched track is the opposite case: the note is chosen by hand, cell by cell,
 * so it travels on the wire and has to mean the same thing on both sides of it.
 * MIDI is that shared meaning, and it mirrors `MinNote`/`MaxNote`/`DefaultNote`
 * of `server/internal/domain/session/pattern.go`.
 */

export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export const MIN_NOTE = 0;
export const MAX_NOTE = 127;

/** C2 — where a bass line sits, and what a cell holds until it is moved. */
export const DEFAULT_BASS_NOTE = 36;

/** Equal temperament from A4 = 440 Hz, which is MIDI 69. */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Scientific pitch notation: MIDI 36 is C2, MIDI 60 is C4. */
export function noteName(midi: number): string {
  const rounded = Math.round(midi);
  // A modulo that does not fold the wrong way on a negative input.
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pitchClass]}${octave}`;
}

export function clampNote(midi: number): number {
  return Math.min(MAX_NOTE, Math.max(MIN_NOTE, Math.round(midi)));
}
