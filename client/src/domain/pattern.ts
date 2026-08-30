/** Port of `server/internal/domain/session/pattern.go`. The console validates
 * a grid before sending it, with the server's own rules. */

import { DEFAULT_BASS_NOTE, clampNote } from "./note";
import type { Pattern, Step, TrackId } from "./types";

export const MAX_STEPS = 64;
export const MAX_TRACKS = 32;

export function newPattern(trackId: TrackId, steps: readonly Step[]): Pattern {
  if (trackId === "") throw new Error("trackId is required");
  if (steps.length === 0) throw new Error(`pattern "${trackId}" has no step`);
  if (steps.length > MAX_STEPS) {
    throw new Error(
      `pattern "${trackId}" has ${steps.length} steps, max is ${MAX_STEPS}`,
    );
  }
  return { trackId, steps: steps.map(clampStep), generation: 0 };
}

function clampStep(step: Step): Step {
  let velocity = step.velocity;
  if (velocity < 0) velocity = 0;
  else if (velocity > 1) velocity = 1;
  // An active step with no velocity plays at full level, as server-side.
  else if (step.on && velocity === 0) velocity = 1;
  return { on: step.on, velocity, note: clampNote(step.note) };
}

export function emptyGrid(length: number): Step[] {
  return Array.from({ length }, () => ({
    on: false,
    velocity: 0,
    note: DEFAULT_BASS_NOTE,
  }));
}

/** Grid resized to `length`, keeping what fits. Used when the maestro changes
 * the signature under an existing pattern. */
export function resizeGrid(steps: readonly Step[], length: number): Step[] {
  const grid = emptyGrid(length);
  for (let i = 0; i < Math.min(length, steps.length); i++) grid[i] = steps[i]!;
  return grid;
}

/** Flips one cell on or off. The pitch is deliberately kept: switching a step
 * back on must return the note the maestro dialled in, not a default. */
export function toggleStep(pattern: Pattern, index: number): Pattern {
  const steps = pattern.steps.map((step, i) =>
    i === index
      ? clampStep({ on: !step.on, velocity: step.on ? 0 : 1, note: step.note })
      : step,
  );
  return { ...pattern, steps };
}

/** The step a pattern plays for a given position in the bar. A grid shorter
 * than the bar simply wraps, which is what makes a 16-step pattern usable at
 * any signature. */
export function stepAt(pattern: Pattern, stepInBar: number): Step | undefined {
  if (pattern.steps.length === 0) return undefined;
  return pattern.steps[stepInBar % pattern.steps.length];
}

/**
 * The step a pattern plays at an *absolute* step index — the scheduler's
 * cursor, counted from beat 0 rather than from the top of the bar.
 *
 * This is what a grid longer than one bar has to be read with. `stepAt` folds
 * on `stepInBar`, so a 32-step strip read through it would replay its first
 * sixteen cells every bar and the second half would never sound. Since the
 * absolute index is `bar × stepsPerBar + stepInBar`, wrapping on it instead
 * gives a loop that spans as many bars as the grid is long, and lands on a bar
 * line whenever the grid is a whole number of bars.
 *
 * A negative index is folded the right way round: `%` alone would return a
 * negative remainder and index off the front of the array.
 */
export function stepAtIndex(pattern: Pattern, index: number): Step | undefined {
  const length = pattern.steps.length;
  if (length === 0) return undefined;
  return pattern.steps[((index % length) + length) % length];
}

/** Whether a grid would make any sound at all. An empty strip is how a group
 * says "nothing written here", which is a different thing from silence. */
export function hasActiveStep(pattern: Pattern | undefined): boolean {
  return pattern !== undefined && pattern.steps.some((step) => step.on);
}
