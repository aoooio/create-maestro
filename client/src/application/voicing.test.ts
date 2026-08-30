import { describe, expect, it } from "vitest";

import { midiToFreq } from "@/domain/note";
import { newPattern } from "@/domain/pattern";
import { stepsBetween } from "@/domain/transport";
import type { StepEvent, Transport } from "@/domain/types";

import { combineVoicings, maestroVoicing, musicianVoicing, triggerNote } from "./voicing";

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
    const phoneA = musicianVoicing({ group: 1, density: 0.6 });
    const phoneB = musicianVoicing({ group: 1, density: 0.6 });

    for (const event of bars(4)) {
      expect(phoneA(event)).toEqual(phoneB(event));
    }
  });

  it("gives the two registers different lines", () => {
    const high = musicianVoicing({ group: 1, density: 1 });
    const mid = musicianVoicing({ group: 2, density: 1 });

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
      bars().filter((event) => musicianVoicing({ group: 1, density })(event).length > 0)
        .length;

    expect(count(0)).toBe(0);
    expect(count(0.3)).toBeGreaterThan(0);
    expect(count(0.3)).toBeLessThan(count(0.7));
    expect(count(0.7)).toBeLessThan(count(1));
  });

  it("puts the first note of every bar on the downbeat", () => {
    const voicing = musicianVoicing({ group: 1, density: 0.3 });
    const downbeats = bars(4).filter((event) => event.stepInBar === 0);
    for (const event of downbeats) {
      expect(voicing(event)).toHaveLength(1);
    }
  });

  it("stays inside the scale, whatever the step", () => {
    const voicing = musicianVoicing({ group: 1, density: 1 });
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

describe("written note strip", () => {
  /** A strip of `length` steps, with a note at each given index. */
  const strip = (length: number, notes: Record<number, number>, velocity = 1) =>
    newPattern(
      "group1",
      Array.from({ length }, (_, index) => ({
        on: index in notes,
        velocity: index in notes ? velocity : 0,
        note: notes[index] ?? 36,
      })),
    );

  const at = (index: number): StepEvent => ({
    serverMs: 0,
    index,
    stepInBar: index % 16,
    bar: Math.floor(index / 16),
    beat: index / 4,
    secondsPerStep: 0.125,
  });

  it("plays the written note instead of the derived figure", () => {
    const written = musicianVoicing({ group: 1, density: 1, strip: strip(16, { 0: 60 }) });
    const derived = musicianVoicing({ group: 1, density: 1 });

    expect(written(at(0))).toHaveLength(1);
    expect(written(at(0))[0]!.freq!).toBeCloseTo(midiToFreq(60), 6);
    expect(written(at(0))[0]!.freq).not.toBeCloseTo(derived(at(0))[0]!.freq!, 6);
    // And a step the maestro left empty is silent, however high the density.
    expect(written(at(1))).toEqual([]);
    expect(derived(at(1)).length).toBeGreaterThan(0);
  });

  it("falls back to the derived figure when nothing is written", () => {
    const derived = musicianVoicing({ group: 1, density: 1 });
    // An absent strip and an empty one mean the same thing: nobody has
    // written here yet, so a console left alone still sounds like music.
    for (const options of [
      { group: 1, density: 1 },
      { group: 1, density: 1, strip: strip(16, {}) },
    ]) {
      const voicing = musicianVoicing(options);
      for (const event of bars(2)) expect(voicing(event)).toEqual(derived(event));
    }
  });

  it("is identical on two phones of the same group", () => {
    // The strip replaces "we all computed the same thing" with "we all read
    // the same grid" — the guarantee has to survive the change.
    const written = strip(32, { 0: 60, 9: 63, 20: 67, 31: 65 });
    const phoneA = musicianVoicing({ group: 1, density: 0.6, strip: written });
    const phoneB = musicianVoicing({ group: 1, density: 0.9, strip: written });

    for (const event of bars(4)) {
      // Note the differing density: it governs the derived figure only, so
      // two phones reading one strip agree regardless of it.
      expect(phoneA(event)).toEqual(phoneB(event));
    }
  });

  it("loops a two-bar strip over two bars, not one", () => {
    const voicing = musicianVoicing({ group: 1, density: 1, strip: strip(32, { 20: 60 }) });
    expect(voicing(at(20))).toHaveLength(1);
    expect(voicing(at(4))).toEqual([]);
    expect(voicing(at(52))).toHaveLength(1); // 20 + 32
  });

  it("transposes a strip by the root, like the bass line", () => {
    const written = strip(16, { 0: 60 });
    const plain = musicianVoicing({ group: 1, density: 1, strip: written });
    const inD = musicianVoicing({ group: 1, density: 1, strip: written, transpose: 2 });
    expect(inD(at(0))[0]!.freq! / plain(at(0))[0]!.freq!).toBeCloseTo(2 ** (2 / 12), 6);
  });

  it("reads the accent off the velocity, and holds one step", () => {
    const loud = musicianVoicing({ group: 1, density: 1, strip: strip(16, { 0: 60 }, 1) });
    const soft = musicianVoicing({ group: 1, density: 1, strip: strip(16, { 0: 60 }, 0.6) });
    expect(loud(at(0))[0]!.accent).toBe(true);
    expect(soft(at(0))[0]!.accent).toBe(false);
    expect(loud(at(0))[0]!.durationSec).toBe(0.125);
  });

  it("renders both paths through the synth voice, on the group's own track", () => {
    // Otherwise the synth panel would be inert until a strip was written.
    for (const voicing of [
      musicianVoicing({ group: 2, density: 1 }),
      musicianVoicing({ group: 2, density: 1, strip: strip(16, { 0: 60 }) }),
    ]) {
      const [note] = voicing(at(0));
      expect(note!.voice).toBe("synth");
      expect(note!.group).toBe(2);
      expect(note!.trackId).toBe("group2");
      expect(note!.sampleId).toBeUndefined();
    }
  });
});

describe("combineVoicings", () => {
  const at = (index: number): StepEvent => ({
    serverMs: 0,
    index,
    stepInBar: index % 16,
    bar: 0,
    beat: index / 4,
    secondsPerStep: 0.125,
  });

  it("hands back one layer untouched", () => {
    const one = musicianVoicing({ group: 1, density: 1 });
    expect(combineVoicings(one)).toBe(one);
  });

  it("plays every layer of a monitored console at once", () => {
    const combined = combineVoicings(
      musicianVoicing({ group: 1, density: 1 }),
      musicianVoicing({ group: 2, density: 1 }),
    );
    const tracks = combined(at(0)).map((note) => note.trackId);
    expect(tracks).toEqual(["group1", "group2"]);
  });

  it("says nothing when no layer does", () => {
    expect(combineVoicings(() => [], () => [])(at(0))).toEqual([]);
  });
});

describe("maestro layer", () => {
  const patterns = new Map([
    ["kick", newPattern("kick", [
      { on: true, velocity: 1, note: 36 },
      { on: false, velocity: 0, note: 36 },
      { on: false, velocity: 0, note: 36 },
      { on: false, velocity: 0, note: 36 },
    ])],
    ["hat", newPattern("hat", [
      { on: false, velocity: 0, note: 36 },
      { on: true, velocity: 0.4, note: 36 },
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
      voicing({ serverMs: 0, index: stepInBar, stepInBar, bar: 0, beat: 0, secondsPerStep: 0.125 }).map((n) => n.trackId);

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
    const notes = voicing({ serverMs: 0, index: 1, stepInBar: 1, bar: 0, beat: 0, secondsPerStep: 0.125 });
    expect(notes[0]!.trackId).toBe("hat");
    expect(notes[0]!.velocity).toBe(0.4);
  });

  it("ignores a track with no pattern yet", () => {
    const voicing = maestroVoicing(patterns, tracks);
    const played = voicing({ serverMs: 0, index: 0, stepInBar: 0, bar: 0, beat: 0, secondsPerStep: 0.125 });
    expect(played.map((note) => note.trackId)).not.toContain("snare");
  });
});

describe("acid bass lane", () => {
  const bassTracks = [{ trackId: "bass", sampleId: "acid", label: "BASS", pitched: true }];
  const line = new Map([
    [
      "bass",
      newPattern("bass", [
        { on: true, velocity: 1, note: 36 }, // C2, accented
        { on: true, velocity: 0.6, note: 43 }, // G2, plain
        { on: false, velocity: 0, note: 48 },
      ]),
    ],
  ]);
  const at = (stepInBar: number, secondsPerStep = 0.125) =>
    ({ serverMs: 0, index: stepInBar, stepInBar, bar: 0, beat: 0, secondsPerStep }) as const;

  it("plays the note written in the cell", () => {
    const voicing = maestroVoicing(line, bassTracks);
    const [note] = voicing(at(0));
    expect(note!.voice).toBe("acid");
    expect(note!.freq!).toBeCloseTo(midiToFreq(36), 6);
  });

  it("transposes the whole line by the root", () => {
    const plain = maestroVoicing(line, bassTracks);
    const inD = maestroVoicing(line, bassTracks, { transpose: 2 });
    for (const step of [0, 1]) {
      const before = plain(at(step))[0]!.freq!;
      const after = inD(at(step))[0]!.freq!;
      // Two semitones up is the same ratio wherever you start.
      expect(after / before).toBeCloseTo(2 ** (2 / 12), 6);
    }
  });

  it("reads the accent off the velocity of the step", () => {
    const voicing = maestroVoicing(line, bassTracks);
    expect(voicing(at(0))[0]!.accent).toBe(true);
    expect(voicing(at(1))[0]!.accent).toBe(false);
  });

  it("holds a note for exactly one step, whatever the tempo", () => {
    const voicing = maestroVoicing(line, bassTracks);
    expect(voicing(at(0))[0]!.durationSec).toBe(0.125);
    expect(voicing(at(0, 0.25))[0]!.durationSec).toBe(0.25);
  });

  it("says nothing on a step that is off, whatever its note", () => {
    const voicing = maestroVoicing(line, bassTracks);
    expect(voicing(at(2))).toEqual([]);
  });

  it("leaves a percussive lane unpitched", () => {
    // A drum track shares the grid — and now the note field — but must not
    // gain a frequency from it.
    const drums = new Map([["kick", newPattern("kick", [{ on: true, velocity: 1, note: 36 }])]]);
    const voicing = maestroVoicing(drums, [{ trackId: "kick", sampleId: "kick" }]);
    const [note] = voicing(at(0));
    expect(note!.voice).toBeUndefined();
    expect(note!.freq).toBeUndefined();
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
