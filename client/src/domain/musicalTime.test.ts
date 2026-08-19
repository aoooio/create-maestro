import { describe, expect, it } from "vitest";

import { beatsToMs, msToBeats, positionAt, stepDurationMs, stepsPerBar } from "./musicalTime";

describe("beat / millisecond conversions", () => {
  const cases: Array<[number, number, number]> = [
    // beats, bpm, ms
    [1, 60, 1000],
    [1, 120, 500],
    [4, 120, 2000],
    [1, 174, 60000 / 174],
    [0, 120, 0],
  ];

  it.each(cases)("%d beats at %d bpm is %d ms", (beats, bpm, ms) => {
    expect(beatsToMs(beats, bpm)).toBeCloseTo(ms, 9);
    expect(msToBeats(ms, bpm)).toBeCloseTo(beats, 9);
  });

  it("gives the wall duration of a step", () => {
    expect(stepDurationMs(120, 4)).toBeCloseTo(125, 9);
    expect(stepDurationMs(60, 1)).toBeCloseTo(1000, 9);
  });
});

describe("positionAt", () => {
  const cases: Array<[number, number, number, number, number, number]> = [
    // beat, beatsPerBar, stepsPerBeat -> bar, beatInBar, stepInBar
    [0, 4, 4, 0, 0, 0],
    [1.5, 4, 4, 0, 1, 6],
    [3.75, 4, 4, 0, 3, 15],
    [4, 4, 4, 1, 0, 0],
    [9.25, 4, 4, 2, 1, 5],
    [7, 3, 2, 2, 1, 2],
  ];

  it.each(cases)(
    "beat %d in %d/%d",
    (beat, beatsPerBar, stepsPerBeat, bar, beatInBar, stepInBar) => {
      const position = positionAt(beat, beatsPerBar, stepsPerBeat);
      expect(position.bar).toBe(bar);
      expect(position.beatInBar).toBe(beatInBar);
      expect(position.stepInBar).toBe(stepInBar);
    },
  );

  it("counts the steps of a bar", () => {
    expect(stepsPerBar(4, 4)).toBe(16);
    expect(stepsPerBar(3, 2)).toBe(6);
  });
});
