import { describe, expect, it } from "vitest";

import { DEFAULT_BASS_NOTE, MAX_NOTE, MIN_NOTE, clampNote, midiToFreq, noteName } from "./note";

describe("midiToFreq", () => {
  it("anchors on A4 = 440 Hz", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });

  it("doubles every octave", () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 6);
    expect(midiToFreq(57)).toBeCloseTo(220, 6);
  });

  it("puts the default bass note where a bass belongs", () => {
    // C2 — low enough to be a bass, high enough to survive a phone speaker.
    expect(midiToFreq(DEFAULT_BASS_NOTE)).toBeCloseTo(65.406, 3);
  });
});

describe("noteName", () => {
  it("uses scientific pitch notation", () => {
    expect(noteName(36)).toBe("C2");
    expect(noteName(60)).toBe("C4");
    expect(noteName(69)).toBe("A4");
    expect(noteName(midiOf("D#", 3))).toBe("D#3");
  });

  it("does not fold the wrong way below C-1", () => {
    // `%` on a negative operand is the classic way to get "B-2" out of this.
    expect(noteName(0)).toBe("C-1");
  });
});

describe("clampNote", () => {
  it("holds the MIDI range", () => {
    expect(clampNote(-40)).toBe(MIN_NOTE);
    expect(clampNote(900)).toBe(MAX_NOTE);
    expect(clampNote(43)).toBe(43);
  });

  it("returns whole semitones", () => {
    expect(clampNote(43.4)).toBe(43);
  });
});

function midiOf(name: string, octave: number): number {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return names.indexOf(name) + (octave + 1) * 12;
}
