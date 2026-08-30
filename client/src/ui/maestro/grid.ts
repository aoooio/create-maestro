/**
 * The geometry both sequencers are drawn on.
 *
 * The playhead is one absolutely positioned column moved by `transform`, so it
 * has to agree with the cells it slides over to the pixel. When only the drum
 * machine had one, those numbers could live beside it; now that the note
 * strips have their own, a disagreement would show up as a playhead drifting
 * off its grid — so both read the figures from here.
 */

/** One cell: `w-6` wide, `gap-2` apart. */
export const CELL_WIDTH_REM = 1.5;
export const CELL_PITCH_REM = 2;

/** Width of the lane label gutter, `w-14` plus the `gap-2` after it — the
 * `left-16` the playhead starts from. */
export const GUTTER_REM = 4;

/** Where the playhead sits for a given step, as a CSS `transform`. */
export function playheadTransform(step: number): string {
  return `translateX(calc(${step} * ${CELL_PITCH_REM}rem))`;
}

/**
 * The trace fades across the step, the way a phosphor column would; a stopped
 * transport leaves it barely lit rather than removing it, so the console still
 * says where the bar is.
 */
export function playheadOpacity(playing: boolean, beatPhase: number): string {
  return playing ? String(0.35 + 0.5 * (1 - beatPhase)) : "0.12";
}
