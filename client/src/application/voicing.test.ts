import { describe, expect, it } from "vitest";

import { newPattern } from "@/domain/pattern";
import { stepsBetween } from "@/domain/transport";
import type { StepEvent, Transport } from "@/domain/types";

import { maestroVoicing, musicianVoicing, triggerNote } from "./voicing";

const transport: Transport = {
  state: "playing",
  anchor: { atServerMs: 0, atBeat: 0, bpm: 120 },
  beatsPerBar: 4,
  stepsPerBeat: 4,
  generation: 0,
};

/** Two bars of steps — enough to see the figure and the progression turn over. */
function bars(count = 2): StepEvent[] {
  return stepsBetween(transport, 0, count * 2000);
}

describe("musician layer", () => {
  it("is identical on two phones of the same group", () => {
    // The point of deriving the melody rather than sending it: no message can
    // arrive late, because no message is sent at all.
    const phoneA = musicianVoicing({ group: 1, density: 0.6, sampleId: "pluck" });
    const phoneB = musicianVoicing({ group: 1, density: 0.6, sampleId: "pluck" });

    for (const event of bars(4)) {
      expect(phoneA(event)).toEqual(phoneB(event));
    }
  });

  it("gives the two registers different lines", () => {
    const high = musicianVoicing({ group: 1, density: 1, sampleId: "pluck" });
    const mid = musicianVoicing({ group: 2, density: 1, sampleId: "pad" });

    const highNotes = bars().flatMap((event) => high(event).map((note) => note.freq!));
    const midNotes = bars().flatMap((event) => mid(event).map((note) => note.freq!));
    expect(highNotes).not.toEqual(midNotes);

    // HIGH sits an octave above MID, which is what keeps them out of each
    // other's way in a room.
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(average(highNotes)).toBeGreaterThan(average(midNotes) * 1.5);
  });

  it("thickens from the strong beats outwards as density rises", () => {
    const count = (density: number) =>
      bars().filter((event) => musicianVoicing({ group: 1, density, sampleId: "pluck" })(event).length > 0)
        .length;

    expect(count(0)).toBe(0);
    expect(count(0.3)).toBeGreaterThan(0);
    expect(count(0.3)).toBeLessThan(count(0.7));
    expect(count(0.7)).toBeLessThan(count(1));
  });

  it("puts the first note of every bar on the downbeat", () => {
    const voicing = musicianVoicing({ group: 1, density: 0.3, sampleId: "pluck" });
    const downbeats = bars(4).filter((event) => event.stepInBar === 0);
    for (const event of downbeats) {
      expect(voicing(event)).toHaveLength(1);
    }
  });

  it("stays inside the scale, whatever the step", () => {
    const voicing = musicianVoicing({ group: 1, density: 1, sampleId: "pluck" });
    const semitones = new Set(
      bars(8)
        .flatMap((event) => voicing(event))
        .map((note) => Math.round(12 * Math.log2(note.freq! / 220)) % 12),
    );
    // Minor pentatonic on A, transposed by the progression (i · i · IV · V).
    const allowed = new Set([0, 3, 5, 7, 10, 8, 2, 9, 4, 11]);
    for (const semitone of semitones) {
      expect(allowed.has(((semitone % 12) + 12) % 12)).toBe(true);
    }
  });
});

describe("maestro layer", () => {
  const patterns = new Map([
    ["kick", newPattern("kick", [
      { on: true, velocity: 1 },
      { on: false, velocity: 0 },
      { on: false, velocity: 0 },
      { on: false, velocity: 0 },
    ])],
    ["hat", newPattern("hat", [
      { on: false, velocity: 0 },
      { on: true, velocity: 0.4 },
    ])],
  ]);
  const tracks = [
    { trackId: "kick", sampleId: "kick" },
    { trackId: "hat", sampleId: "hat" },
    { trackId: "snare", sampleId: "snare" },
  ];

  it("plays exactly what the grid says", () => {
    const voicing = maestroVoicing(patterns, tracks);
    const step = (stepInBar: number) =>
      voicing({ serverMs: 0, index: stepInBar, stepInBar, bar: 0, beat: 0 }).map((n) => n.trackId);

    // The kick grid is 4 long and the hat grid 2, so both wrap over the bar:
    // a 16-step bar plays each of them four and eight times over.
    expect(step(0)).toEqual(["kick"]);
    expect(step(1)).toEqual(["hat"]);
    expect(step(2)).toEqual([]);
    expect(step(3)).toEqual(["hat"]);
    expect(step(4)).toEqual(["kick"]);
    expect(step(5)).toEqual(["hat"]);
  });

  it("carries the velocity of the step", () => {
    const voicing = maestroVoicing(patterns, tracks);
    const notes = voicing({ serverMs: 0, index: 1, stepInBar: 1, bar: 0, beat: 0 });
    expect(notes[0]!.trackId).toBe("hat");
    expect(notes[0]!.velocity).toBe(0.4);
  });

  it("ignores a track with no pattern yet", () => {
    const voicing = maestroVoicing(patterns, tracks);
    const played = voicing({ serverMs: 0, index: 0, stepInBar: 0, bar: 0, beat: 0 });
    expect(played.map((note) => note.trackId)).not.toContain("snare");
  });
});

describe("trigger", () => {
  it("maps intensity onto pitch and level", () => {
    const soft = triggerNote(1, 0);
    const hard = triggerNote(1, 1);
    expect(hard.freq!).toBeGreaterThan(soft.freq!);
    expect(hard.velocity).toBeGreaterThan(soft.velocity);
    expect(soft.velocity).toBeGreaterThan(0);
  });
});
