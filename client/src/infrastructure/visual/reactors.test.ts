import { describe, expect, it } from "vitest";

import { newTimeline } from "@/domain/transport";
import type { Transport } from "@/domain/types";

import { sceneInputs } from "./reactors";

const playing: Transport = {
  state: "playing",
  anchor: { atServerMs: 0, atBeat: 0, bpm: 120 },
  beatsPerBar: 4,
  stepsPerBeat: 4,
  generation: 0,
};

const base = { level: 0, param: 0.5 };

describe("beat phase", () => {
  it("is zero on the downbeat and climbs to the next one", () => {
    // 120 BPM: a beat lasts 500 ms.
    const at = (ms: number) =>
      sceneInputs({ ...base, timeline: newTimeline(playing), serverNowMs: ms }).beatPhase;

    expect(at(0)).toBeCloseTo(0, 9);
    expect(at(250)).toBeCloseTo(0.5, 9);
    expect(at(499)).toBeGreaterThan(0.99);
    expect(at(500)).toBeCloseTo(0, 9);
  });

  it("stays in [0, 1) before beat zero", () => {
    // A transport anchored in the future is normal right after joining; a bare
    // `beat % 1` would go negative here and flash on the wrong side of the beat.
    const timeline = newTimeline({ ...playing, anchor: { atServerMs: 10_000, atBeat: 0, bpm: 120 } });
    for (const ms of [0, 1234, 9999]) {
      const phase = sceneInputs({ ...base, timeline, serverNowMs: ms }).beatPhase;
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });
});

describe("scene inputs", () => {
  it("reports a stopped transport as still", () => {
    const timeline = newTimeline({ ...playing, state: "stopped" });
    expect(sceneInputs({ ...base, timeline, serverNowMs: 5000 }).playing).toBe(false);
  });

  it("follows a queued tempo change at its boundary", () => {
    const timeline = {
      active: playing,
      pending: [{ transport: { ...playing, state: "stopped" as const }, effectiveAtServerMs: 2000 }],
    };
    expect(sceneInputs({ ...base, timeline, serverNowMs: 1999 }).playing).toBe(true);
    expect(sceneInputs({ ...base, timeline, serverNowMs: 2000 }).playing).toBe(false);
  });

  it("clamps whatever the analyser hands it", () => {
    const timeline = newTimeline(playing);
    const at = (level: number) =>
      sceneInputs({ ...base, level, timeline, serverNowMs: 0 }).level;

    expect(at(-1)).toBe(0);
    expect(at(4)).toBe(1);
    expect(at(Number.NaN)).toBe(0);
  });
});
