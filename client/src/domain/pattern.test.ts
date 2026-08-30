import { describe, expect, it } from "vitest";

import { emptyGrid, hasActiveStep, resizeGrid, stepAt, stepAtIndex } from "./pattern";
import type { Pattern, Step } from "./types";

/** A grid whose cells are switched on at the given indices, so a test can say
 * "the 5th step" and read the answer back by index. */
function grid(length: number, on: readonly number[]): Pattern {
  const steps: Step[] = emptyGrid(length).map((step, index) =>
    on.includes(index) ? { ...step, on: true, velocity: 1, note: 36 + index } : step,
  );
  return { trackId: "group1", steps, generation: 0 };
}

describe("stepAt", () => {
  it("wraps a short grid onto the bar", () => {
    const pattern = grid(4, [0]);
    expect(stepAt(pattern, 0)?.on).toBe(true);
    expect(stepAt(pattern, 4)?.on).toBe(true);
    expect(stepAt(pattern, 1)?.on).toBe(false);
  });

  it("has nothing to say about an empty grid", () => {
    expect(stepAt({ trackId: "group1", steps: [], generation: 0 }, 0)).toBeUndefined();
  });
});

describe("stepAtIndex", () => {
  const BAR = 16;

  it("reads a one-bar grid exactly as stepAt does", () => {
    const pattern = grid(BAR, [0, 7]);
    for (let bar = 0; bar < 3; bar++) {
      for (let inBar = 0; inBar < BAR; inBar++) {
        expect(stepAtIndex(pattern, bar * BAR + inBar)).toBe(stepAt(pattern, inBar));
      }
    }
  });

  it("lets a two-bar strip use its second bar", () => {
    // The whole point of the function. Read through `stepAt`, cell 20 would
    // fold onto cell 4 and the second half of the strip would never sound.
    const pattern = grid(2 * BAR, [20]);
    expect(stepAtIndex(pattern, 20)?.on).toBe(true);
    expect(stepAtIndex(pattern, 4)?.on).toBe(false);
    expect(stepAt(pattern, 4)?.on).toBe(false);
    // …and it comes back two bars later, not one.
    expect(stepAtIndex(pattern, 20 + 2 * BAR)?.on).toBe(true);
    expect(stepAtIndex(pattern, 20 + BAR)?.on).toBe(false);
  });

  it("loops a four-bar strip over four bars", () => {
    const pattern = grid(4 * BAR, [63]);
    expect(stepAtIndex(pattern, 63)?.on).toBe(true);
    expect(stepAtIndex(pattern, 63 + 4 * BAR)?.on).toBe(true);
    expect(stepAtIndex(pattern, 63 - BAR)?.on).toBe(false);
  });

  it("folds a negative index the right way round", () => {
    const pattern = grid(BAR, [15]);
    expect(stepAtIndex(pattern, -1)?.on).toBe(true);
  });

  it("has nothing to say about an empty grid", () => {
    expect(stepAtIndex({ trackId: "group1", steps: [], generation: 0 }, 3)).toBeUndefined();
  });
});

describe("hasActiveStep", () => {
  it("tells an unwritten strip from a written one", () => {
    expect(hasActiveStep(undefined)).toBe(false);
    expect(hasActiveStep(grid(16, []))).toBe(false);
    expect(hasActiveStep(grid(16, [3]))).toBe(true);
  });
});

describe("resizeGrid", () => {
  it("keeps what fits when a strip is lengthened or shortened", () => {
    const steps = grid(16, [0, 15]).steps;
    const longer = resizeGrid(steps, 32);
    expect(longer).toHaveLength(32);
    expect(longer[15]?.on).toBe(true);
    expect(longer[16]?.on).toBe(false);

    const shorter = resizeGrid(steps, 8);
    expect(shorter).toHaveLength(8);
    expect(shorter[0]?.on).toBe(true);
  });
});
