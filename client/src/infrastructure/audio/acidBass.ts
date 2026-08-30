/**
 * The acid bass, and the one voice in this codebase that is *not* a rendered
 * buffer.
 *
 * Every other voice is rendered once into an `OfflineAudioContext` and
 * transposed by `playbackRate` (`voices.ts`, `engine.ts`). That model cannot
 * carry this one: a 303's character is a filter sweep per note, and playback
 * rate would transpose the sweep along with the pitch — a low note would get a
 * slow, dull sweep and a high one a fast, bright one, which is precisely
 * backwards. Worse, a pre-rendered sweep is baked in, and the maestro has to be
 * able to turn the cutoff while the line is playing.
 *
 * So each note is built for itself: one oscillator, one resonant lowpass with
 * its own envelope, one VCA. The rules of `engine.ts` still hold — the source
 * is started *at an instant*, and the caller keeps what it is handed so that a
 * tempo change can take the note back (§5.4).
 */

import { cutoffToHz, resonanceToQ } from "./effects";
import type { StoppableVoice } from "./voice";

/** Every value is 0..1, as the parameter registry stores them. */
export interface AcidSettings {
  readonly cutoff: number;
  readonly resonance: number;
  /** How far the filter envelope opens above the cutoff. */
  readonly envMod: number;
  /** How long it takes to fall back. */
  readonly decay: number;
  /** How much an accented step exaggerates all of the above. */
  readonly accent: number;
}

export const DEFAULT_ACID: AcidSettings = {
  cutoff: 0.35,
  resonance: 0.7,
  envMod: 0.6,
  decay: 0.4,
  accent: 0.5,
};

/** A bass line lives low. Letting the cutoff run to 18 kHz as the shared track
 * filter does would spend the top of the dial somewhere the voice has nothing
 * left to give — and it would stop sounding acid long before the end. */
const MAX_BASS_HZ = 4_000;
/** How far the envelope can open, as a multiple of the resting cutoff. */
const ENV_DEPTH = 12;
/** Nyquist is not the limit that matters; this is what the ear will take. */
const MAX_SWEEP_HZ = 12_000;

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.04;
/** Notes are legato-ish but never overlap the next step. */
const GATE = 0.9;
/**
 * Level of an unaccented note before the track gain. Lower than it looks like
 * it should be, and deliberately: a saw through a resonant lowpass overshoots
 * badly — at a Q of 8 the filter alone adds most of a doubling. Set for the
 * peak that comes *out*, this lands a plain note near 0.8 and an accented one
 * just under full scale, so the bass reaches the limiter at the same height as
 * every other voice instead of ducking the whole mix under itself.
 */
const BASE_LEVEL = 0.45;

/** The filter envelope, from a snap to a long swell. */
function decayToSec(decay: number): number {
  return 0.04 + clamp01(decay) * 1.16;
}

export interface AcidNote {
  /** Audio-context time to start at. Never "now": the scheduler decides. */
  readonly when: number;
  readonly freq: number;
  /** 0..1, from the step's velocity. */
  readonly velocity: number;
  readonly accent: boolean;
  /** One step at the tempo governing this step. */
  readonly durationSec: number;
}

/**
 * Builds and starts one note. Returns the handle the engine keeps until the
 * note ends, so that `cancelFrom` can take it back mid-flight.
 */
export function playAcidNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  note: AcidNote,
  settings: AcidSettings,
  onEnded?: () => void,
): StoppableVoice {
  const accent = note.accent ? clamp01(settings.accent) : 0;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(note.freq, note.when);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  // The shared curves, so a 303 cutoff and a track cutoff mean the same thing
  // to the hand that turns them — only the ceiling differs.
  const base = Math.min(MAX_BASS_HZ, cutoffToHz(clamp01(settings.cutoff)));
  const depth = clamp01(settings.envMod) * (1 + accent);
  const peak = Math.min(MAX_SWEEP_HZ, base * (1 + depth * ENV_DEPTH));
  const sweepSec = decayToSec(settings.decay) * (1 - 0.4 * accent);

  filter.Q.setValueAtTime(resonanceToQ(clamp01(settings.resonance) * (1 + 0.3 * accent)), note.when);
  filter.frequency.setValueAtTime(peak, note.when);
  // Exponential, because a filter sweep is heard in octaves — and it is this
  // fall, not the oscillator, that people mean by "acid".
  filter.frequency.exponentialRampToValueAtTime(base, note.when + sweepSec);

  const gate = Math.max(0.03, note.durationSec * GATE);
  const level = clamp01(note.velocity) * BASE_LEVEL * (1 + 0.35 * accent);

  const vca = ctx.createGain();
  // Never `setValueAtTime(0)` before an exponential ramp: it is illegal, and
  // some engines silently kill the node instead of saying so.
  vca.gain.setValueAtTime(0.0001, note.when);
  vca.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), note.when + ATTACK_SEC);
  vca.gain.setValueAtTime(Math.max(0.0001, level), note.when + gate);
  vca.gain.exponentialRampToValueAtTime(0.0001, note.when + gate + RELEASE_SEC);

  osc.connect(filter).connect(vca).connect(destination);

  const endsAt = note.when + gate + RELEASE_SEC;
  osc.start(note.when);
  osc.stop(endsAt);
  osc.onended = () => {
    osc.disconnect();
    filter.disconnect();
    vca.disconnect();
    onEnded?.();
  };

  return {
    stop(at?: number) {
      // A second `stop` past the scheduled one is a no-op in the platform, and
      // an earlier one simply wins — which is exactly what a tempo change
      // wants. Cutting the gain first keeps that from being a click.
      const cut = at ?? ctx.currentTime;
      try {
        vca.gain.cancelScheduledValues(cut);
        vca.gain.setValueAtTime(Math.max(0.0001, vca.gain.value), cut);
        vca.gain.exponentialRampToValueAtTime(0.0001, cut + RELEASE_SEC);
        osc.stop(cut + RELEASE_SEC);
      } catch {
        // Already finished, or never started: nothing to take back.
      }
    },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
