/**
 * The voice a group's phones play — synthesised per note, like the acid bass
 * and for the same reason.
 *
 * The layers used to be rendered buffers (`pluck`, `pad`) transposed by
 * `playbackRate`. That model cannot be edited: the waveform, the filter and
 * the envelope are baked into the buffer before the maestro ever sees the
 * console, and `playbackRate` drags the envelope along with the pitch, so a
 * high note gets a short bright swell and a low one a long dull one. Once the
 * maestro is allowed to turn a knob and hear the room change, the sound has to
 * be built at the moment it is played.
 *
 * The rules of `engine.ts` still hold: the source is started *at an instant*
 * chosen by the scheduler, and the caller keeps the handle it is given so a
 * tempo change can take the note back (§5.4). Nothing here reads a store —
 * settings arrive as an argument, which is what makes the voice renderable in
 * an `OfflineAudioContext` and testable without a room.
 */

import { cutoffToHz, resonanceToQ } from "./effects";
import type { StoppableVoice } from "./voice";

/** Every value is 0..1 as the parameter registry stores them, except `wave`
 * (an index into `WAVES`) and `octave` (signed semitone shifts of twelve). */
export interface GroupSynthSettings {
  /** 0..3 → sawtooth | square | triangle | sine. */
  readonly wave: number;
  /** Detune between the two oscillators. */
  readonly spread: number;
  /** How long the note takes to arrive: a pluck against a swell. */
  readonly attack: number;
  /** How long it takes to leave — the other half of pluck against pad. */
  readonly release: number;
  /** How far the note's own lowpass opens on the attack. */
  readonly brightness: number;
  /** Register of the layer, −2..+2 octaves. */
  readonly octave: number;
}

export const DEFAULT_SYNTH: GroupSynthSettings = {
  wave: 0,
  spread: 0.4,
  attack: 0.05,
  release: 0.35,
  brightness: 0.5,
  octave: 0,
};

const WAVE_TYPES: readonly OscillatorType[] = ["sawtooth", "square", "triangle", "sine"];

/** Widest detune between the two oscillators, in cents. Past this the pair
 * stops beating and starts sounding out of tune. */
const MAX_SPREAD_CENTS = 25;

const MIN_ATTACK_SEC = 0.002;
const MAX_ATTACK_SEC = 0.8;
const MIN_RELEASE_SEC = 0.06;
const MAX_RELEASE_SEC = 3;

/** Resting cutoff of the voice's own filter. The group's `cutoff` parameter is
 * a ceiling applied on the track bus; this one shapes each note under it. */
const BASE_CUTOFF = 0.32;
/** How far `brightness` can open that filter, as a multiple of the resting
 * frequency. */
const BRIGHTNESS_DEPTH = 9;
/** Enough to give the voice body without letting it ring; the layer is played
 * by a crowd, and a resonant peak multiplied by fifty is a problem. */
const VOICE_RESONANCE = 0.25;

/**
 * Level of one note before the track gain. Fifty phones play this in unison,
 * so it sits well below the maestro's own voices and lets the limiter do the
 * rest.
 */
const BASE_LEVEL = 0.5;

/** Notes are held for most of their step, never into the next one. */
const GATE = 0.9;

export interface SynthNote {
  /** Audio-context time to start at. Never "now": the scheduler decides. */
  readonly when: number;
  readonly freq: number;
  /** 0..1, from the step's velocity. */
  readonly velocity: number;
  /** A written step can be accented, exactly as on the acid line. */
  readonly accent: boolean;
  /** One step at the tempo governing this step. */
  readonly durationSec: number;
}

/**
 * Builds and starts one note. Returns the handle the engine keeps until the
 * note ends, so that `cancelFrom` can take it back mid-flight.
 */
export function playSynthNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  note: SynthNote,
  settings: GroupSynthSettings,
  onEnded?: () => void,
): StoppableVoice {
  const type = WAVE_TYPES[Math.round(clamp(settings.wave, 0, WAVE_TYPES.length - 1))]!;
  const freq = note.freq * 2 ** Math.round(clamp(settings.octave, -2, 2));
  const accent = note.accent ? 1 : 0;

  const attackSec = lerp(MIN_ATTACK_SEC, MAX_ATTACK_SEC, clamp01(settings.attack));
  const releaseSec = lerp(MIN_RELEASE_SEC, MAX_RELEASE_SEC, clamp01(settings.release));

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  // The shared curves, so that a value means the same thing here, on the acid
  // bass and on the track bus — only the ceiling differs.
  const base = cutoffToHz(BASE_CUTOFF);
  const depth = clamp01(settings.brightness) * (1 + 0.4 * accent);
  const peak = Math.min(16_000, base * (1 + depth * BRIGHTNESS_DEPTH));
  filter.Q.setValueAtTime(resonanceToQ(VOICE_RESONANCE), note.when);
  filter.frequency.setValueAtTime(base, note.when);
  // The filter opens with the note and closes behind it. Heard in octaves, so
  // ramped exponentially — a linear sweep sounds like it happens all at once
  // at the top.
  filter.frequency.exponentialRampToValueAtTime(peak, note.when + attackSec);
  filter.frequency.exponentialRampToValueAtTime(base, note.when + attackSec + releaseSec);

  // The gate is what the note is *asked* to last; the release can outlive it,
  // which is what lets a pad overlap the next step and a pluck not.
  const gate = Math.max(0.03, note.durationSec * GATE);
  const level = clamp01(note.velocity) * BASE_LEVEL * (1 + 0.3 * accent);

  const vca = ctx.createGain();
  // Never `setValueAtTime(0)` before an exponential ramp: it is illegal, and
  // some engines silently kill the node instead of saying so.
  vca.gain.setValueAtTime(0.0001, note.when);
  vca.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), note.when + attackSec);
  vca.gain.setValueAtTime(Math.max(0.0001, level), note.when + gate);
  vca.gain.exponentialRampToValueAtTime(0.0001, note.when + gate + releaseSec);

  filter.connect(vca).connect(destination);

  const endsAt = note.when + gate + releaseSec;
  const cents = clamp01(settings.spread) * MAX_SPREAD_CENTS;
  const oscillators: OscillatorNode[] = [];
  // Two oscillators a few cents apart. The beating between them is what stops
  // fifty phones playing the same note from sounding like one very loud phone.
  for (const detune of [-cents, cents]) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, note.when);
    osc.detune.setValueAtTime(detune, note.when);
    osc.connect(filter);
    osc.start(note.when);
    osc.stop(endsAt);
    oscillators.push(osc);
  }

  // One `onended` for the pair: the two are stopped together, and the engine
  // must stop remembering the voice exactly once.
  oscillators[0]!.onended = () => {
    for (const osc of oscillators) osc.disconnect();
    filter.disconnect();
    vca.disconnect();
    onEnded?.();
  };

  return {
    stop(at?: number) {
      // A second `stop` past the scheduled one is a no-op in the platform, and
      // an earlier one simply wins — which is what a tempo change wants.
      // Cutting the gain first keeps that from being a click.
      const cut = at ?? ctx.currentTime;
      try {
        vca.gain.cancelScheduledValues(cut);
        vca.gain.setValueAtTime(Math.max(0.0001, vca.gain.value), cut);
        vca.gain.exponentialRampToValueAtTime(0.0001, cut + MIN_RELEASE_SEC);
        for (const osc of oscillators) osc.stop(cut + MIN_RELEASE_SEC);
      } catch {
        // Already finished, or never started: nothing to take back.
      }
    },
  };
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}
