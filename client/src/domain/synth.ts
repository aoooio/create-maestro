/**
 * The four voices the console offers as a starting point.
 *
 * A preset is **not** a piece of protocol state. Nothing on the wire says
 * "GROUP 1 is a PAD": pressing a preset writes the six synth parameters of
 * that group and nothing else, exactly as SOLO in the group mixer writes a
 * `mute` at everyone else rather than inventing a solo message. The server
 * stores values; the console has opinions about which values go together.
 *
 * That is also why the table lives in the domain: it is data over parameter
 * keys, with no notion of a button, a fader or a click — the panel reads it,
 * and so could a test, a URL, or a future "recall" feature.
 */

import type { ParameterKey } from "./parameter";

export type SynthPresetName = "PLUCK" | "PAD" | "BELL" | "STAB";

/** Every key a preset speaks for. A preset must set all of them: recalling a
 * sound that inherits half of the previous one is not a recall. */
export const SYNTH_KEYS = [
  "synthWave",
  "synthSpread",
  "synthAttack",
  "synthRelease",
  "synthBrightness",
  "synthOctave",
] as const satisfies readonly ParameterKey[];

export type SynthKey = (typeof SYNTH_KEYS)[number];

export type SynthPreset = Readonly<Record<SynthKey, number>>;

/** Waveform indices, as `synthWave` stores them. */
export const WAVES = ["SAW", "SQR", "TRI", "SIN"] as const;

/**
 * PLUCK and PAD carry over the character of the two rendered buffers they
 * replace — a bright detuned saw that falls away, and a slow warm swell — so a
 * session that never touches the panel sounds like the one before it.
 */
export const SYNTH_PRESETS: Readonly<Record<SynthPresetName, SynthPreset>> = {
  PLUCK: {
    synthWave: 0,
    synthSpread: 0.5,
    synthAttack: 0.02,
    synthRelease: 0.3,
    synthBrightness: 0.7,
    synthOctave: 0,
  },
  PAD: {
    synthWave: 2,
    synthSpread: 0.7,
    synthAttack: 0.45,
    synthRelease: 0.8,
    synthBrightness: 0.35,
    synthOctave: 0,
  },
  BELL: {
    synthWave: 3,
    synthSpread: 0.15,
    synthAttack: 0,
    synthRelease: 0.55,
    synthBrightness: 0.9,
    synthOctave: 1,
  },
  STAB: {
    synthWave: 1,
    synthSpread: 0.3,
    synthAttack: 0,
    synthRelease: 0.12,
    synthBrightness: 0.6,
    synthOctave: -1,
  },
};

export const SYNTH_PRESET_NAMES = Object.keys(SYNTH_PRESETS) as SynthPresetName[];

/**
 * The preset a set of live values corresponds to, or `null` once the maestro
 * has moved a fader away from it. Comparison is exact: these are the numbers
 * the preset itself wrote, and a value that has been through the server comes
 * back unchanged inside its bounds.
 */
export function matchingPreset(
  read: (key: SynthKey) => number,
): SynthPresetName | null {
  for (const name of SYNTH_PRESET_NAMES) {
    const preset = SYNTH_PRESETS[name];
    if (SYNTH_KEYS.every((key) => read(key) === preset[key])) return name;
  }
  return null;
}
