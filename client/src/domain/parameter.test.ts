import { describe, expect, it } from "vitest";

import {
  PARAMETER_REGISTRY,
  clampParameter,
  defaultValue,
  effectiveParameter,
  lookupParameter,
  parameterSlot,
} from "./parameter";
import type { ParameterEntry } from "./types";

describe("parameter registry", () => {
  it("matches the bounds and defaults of the Go registry", () => {
    expect(defaultValue(PARAMETER_REGISTRY.cutoff)).toBe(1);
    expect(defaultValue(PARAMETER_REGISTRY.resonance)).toBe(0);
    expect(defaultValue(PARAMETER_REGISTRY.density)).toBe(0.5);
    expect(defaultValue(PARAMETER_REGISTRY.gain)).toBe(0.8);
    expect(defaultValue(PARAMETER_REGISTRY.reverb)).toBe(0.2);
    expect(defaultValue(PARAMETER_REGISTRY.delay)).toBe(0);
    expect(defaultValue(PARAMETER_REGISTRY.mute)).toBe(false);
  });

  it("mirrors the bounds of the group synth keys", () => {
    // A waveform is an index and an octave is signed: both would survive a
    // registry that quietly assumed 0..1, and neither would sound right.
    expect(PARAMETER_REGISTRY.synthWave.max).toBe(3);
    expect(PARAMETER_REGISTRY.synthOctave.min).toBe(-2);
    expect(clampParameter(PARAMETER_REGISTRY.synthOctave, -1)).toBe(-1);
    expect(clampParameter(PARAMETER_REGISTRY.synthOctave, -9)).toBe(-2);
    expect(clampParameter(PARAMETER_REGISTRY.synthWave, 9)).toBe(3);
    expect(defaultValue(PARAMETER_REGISTRY.synthRelease)).toBe(0.35);
  });

  it("rejects a key the server does not know", () => {
    expect(lookupParameter("cutoff")).toBeDefined();
    expect(lookupParameter("wobble")).toBeUndefined();
  });

  it("clamps to the bounds rather than refusing", () => {
    expect(clampParameter(PARAMETER_REGISTRY.cutoff, 2)).toBe(1);
    expect(clampParameter(PARAMETER_REGISTRY.cutoff, -3)).toBe(0);
    expect(clampParameter(PARAMETER_REGISTRY.cutoff, 0.42)).toBe(0.42);
  });

  it("normalises a boolean parameter through 0/1", () => {
    expect(clampParameter(PARAMETER_REGISTRY.mute, 1)).toBe(true);
    expect(clampParameter(PARAMETER_REGISTRY.mute, 0)).toBe(false);
  });
});

describe("effectiveParameter", () => {
  const params = new Map<string, ParameterEntry>([
    [
      parameterSlot("cutoff", { group: 0 }),
      { key: "cutoff", value: 0.5, target: { group: 0 } },
    ],
    [
      parameterSlot("cutoff", { group: 2 }),
      { key: "cutoff", value: 0.2, target: { group: 2 } },
    ],
  ]);

  it("prefers the group scope over the session scope", () => {
    expect(effectiveParameter(params, "cutoff", 2)).toBe(0.2);
  });

  it("falls back to the session scope", () => {
    expect(effectiveParameter(params, "cutoff", 1)).toBe(0.5);
  });

  it("falls back to the domain default when nothing is set", () => {
    expect(effectiveParameter(params, "reverb", 1)).toBe(0.2);
  });
});
