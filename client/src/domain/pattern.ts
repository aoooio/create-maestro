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
