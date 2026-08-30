import { describe, expect, it } from "vitest";

import { noteName } from "./note";
import {
  PENTATONIC_MINOR,
  STRIP_ROWS,
  groupBaseNote,
  groupTrackId,
  noteForRow,
  rowForNote,
} from "./scale";

describe("noteForRow", () => {
  it("starts a group's grid on its base note", () => {
    expect(noteForRow(2, 0)).toBe(groupBaseNote(2));
    expect(noteName(noteForRow(2, 0))).toBe("A3");
  });

  it("walks the scale and rolls into the next octave", () => {
    for (let degree = 0; degree < PENTATONIC_MINOR.length; degree++) {
      expect(noteForRow(2, degree)).toBe(groupBaseNote(2) + PENTATONIC_MINOR[degree]!);
    }
    // The row after the last degree is the root again, an octave up — that is
    // what makes the grid readable as two stacked copies of one shape.
    expect(noteForRow(2, PENTATONIC_MINOR.length)).toBe(groupBaseNote(2) + 12);
  });

  it("keeps HIGH an octave above MID", () => {
    for (let row = 0; row < STRIP_ROWS; row++) {
      expect(noteForRow(1, row) - noteForRow(2, row)).toBe(12);
    }
  });

  it("clamps a row off either end of the grid", () => {
    expect(noteForRow(1, -5)).toBe(noteForRow(1, 0));
    expect(noteForRow(1, STRIP_ROWS + 5)).toBe(noteForRow(1, STRIP_ROWS - 1));
  });
});

describe("rowForNote", () => {
  it("is the inverse of noteForRow across the whole grid", () => {
    for (const group of [1, 2]) {
      for (let row = 0; row < STRIP_ROWS; row++) {
        expect(rowForNote(group, noteForRow(group, row))).toBe(row);
      }
    }
  });

  it("says so when a pitch is not on the grid", () => {
    // A semitone above the root is not in a minor pentatonic, so the grid
    // cannot draw it — and must not pretend it can.
    expect(rowForNote(2, groupBaseNote(2) + 1)).toBeNull();
    expect(rowForNote(2, groupBaseNote(2) - 12)).toBeNull();
  });
});

describe("groupTrackId", () => {
  it("names one track per group", () => {
    expect(groupTrackId(1)).toBe("group1");
    expect(groupTrackId(2)).toBe("group2");
  });
});
