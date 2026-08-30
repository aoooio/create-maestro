/**
 * The bridge between a row of the console's note grid and a MIDI pitch.
 *
 * It lives in the domain, and not in the component that draws the grid,
 * because it is a musical rule rather than a detail of layout: the maestro
 * writes a strip by picking rows, every phone of the group plays the MIDI
 * notes that come out of it, and the two readings must be the same one. Put
 * the mapping in the component and the sequencer becomes the only place that
 * knows what a row means — which is exactly how a grid ends up displaying one
 * note and sounding another.
 *
 * The grid is diatonic on purpose. A chromatic roll would let the maestro
 * write an interval that fights the acid bass while fifty phones play it back
 * at once, in a room where nobody can stop and fix it. Restricting the rows to
 * a minor pentatonic means a strip written blind, on a dark stage, still lands
 * in the key — the same reasoning that put the scale in the derived voicing in
 * the first place.
 */

import type { GroupId, TrackId } from "./types";

/** No interval in it can clash with another, which matters when the players
 * cannot hear each other. */
export const PENTATONIC_MINOR = [0, 3, 5, 7, 10] as const;

/** Rows of one strip: two octaves of the scale. Enough range to write a line
 * that goes somewhere, few enough rows to read the whole strip at a glance
 * from behind a console. */
export const STRIP_ROWS = PENTATONIC_MINOR.length * 2;

/** Reference pitch of the layers, A3 — MIDI 57, the octave the audio engine's
 * `BASE_FREQ` names. */
export const LAYER_BASE_NOTE = 57;

/**
 * Where a group's strip sits. GROUP 1 (HIGH) is written an octave above
 * GROUP 2 (MID) so the two registers interlock instead of fighting for the
 * same space — the same split the derived figures already make, expressed once
 * here so both paths agree.
 */
export function groupBaseNote(group: GroupId): number {
  return LAYER_BASE_NOTE + (group === 1 ? 12 : 0);
}

/** MIDI pitch of a row, counted from the bottom of the grid. */
export function noteForRow(group: GroupId, row: number): number {
  const clamped = Math.max(0, Math.min(STRIP_ROWS - 1, Math.round(row)));
  const degree = clamped % PENTATONIC_MINOR.length;
  const octave = Math.floor(clamped / PENTATONIC_MINOR.length);
  return groupBaseNote(group) + PENTATONIC_MINOR[degree]! + 12 * octave;
}

/**
 * The row a pitch belongs to, or `null` when it is not one of the grid's
 * pitches. A strip can hold a note the grid cannot draw — an older session may
 * carry anything — so the caller has to be told rather than handed a wrong row.
 */
export function rowForNote(group: GroupId, midi: number): number | null {
  for (let row = 0; row < STRIP_ROWS; row++) {
    if (noteForRow(group, row) === Math.round(midi)) return row;
  }
  return null;
}

/** The track a group's strip travels on. `pattern.set` is generic over the
 * track id, so a strip needs no new message — only a name both sides agree
 * on. */
export function groupTrackId(group: GroupId): TrackId {
  return `group${group}`;
}
