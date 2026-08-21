/**
 * The sound sources, rendered rather than downloaded.
 *
 * Each voice is a short recipe run once into an `OfflineAudioContext`, which
 * produces exactly the same `AudioBuffer` a `.wav` would have produced — so
 * the engine, the loader and the scheduler never learn where a buffer came
 * from. Dropping real samples in later is a change of manifest, not a change
 * of engine (see `sampleLoader.ts`).
 *
 * Rendering them also removes a class of failure that matters at a live event:
 * there is nothing to fetch, so nothing to fail on a saturated venue Wi-Fi
 * while two hundred phones try to join at once.
 */

/** Pitched voices are rendered once at this frequency and transposed by
 * playback rate, the way a sampler does. */
export const BASE_FREQ = 220;

export interface SampleSpec {
  readonly id: string;
  readonly durationSec: number;
  /** Set on pitched voices; absent on percussion. */
  readonly baseFreq?: number;
  /** Optional override: a real file, decoded instead of rendered. */
  readonly url?: string;
  render(ctx: OfflineAudioContext): void;
}

/** White noise, the raw material of every percussive voice here. */
function noiseBuffer(ctx: OfflineAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function noiseSource(ctx: OfflineAudioContext, seconds: number): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, seconds);
  return source;
}

/** Percussive envelope: instant attack, exponential decay. `setValueAtTime(0)`
 * is never used on an exponential ramp — it is illegal and silently kills the
 * node in some engines. */
function decay(ctx: OfflineAudioContext, peak: number, seconds: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peak, 0);
  gain.gain.exponentialRampToValueAtTime(0.0001, seconds);
  return gain;
}

const kick: SampleSpec = {
  id: "kick",
  durationSec: 0.42,
  render(ctx) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    // The pitch drop is what makes a sine sound like a drum rather than a beep.
    osc.frequency.setValueAtTime(140, 0);
    osc.frequency.exponentialRampToValueAtTime(42, 0.12);

    const body = decay(ctx, 1, 0.4);

    // A short noise transient gives the attack something to bite on.
    const click = noiseSource(ctx, 0.02);
    const clickGain = decay(ctx, 0.35, 0.02);
    const clickFilter = ctx.createBiquadFilter();
    clickFilter.type = "highpass";
    clickFilter.frequency.value = 1200;

    osc.connect(body).connect(ctx.destination);
    click.connect(clickFilter).connect(clickGain).connect(ctx.destination);
    osc.start(0);
    osc.stop(0.42);
    click.start(0);
  },
};

const snare: SampleSpec = {
  id: "snare",
  durationSec: 0.25,
  render(ctx) {
    const noise = noiseSource(ctx, 0.25);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1900;
    band.Q.value = 0.7;

    const tone = ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.setValueAtTime(190, 0);
    tone.frequency.exponentialRampToValueAtTime(140, 0.1);

    noise.connect(band).connect(decay(ctx, 0.9, 0.2)).connect(ctx.destination);
    tone.connect(decay(ctx, 0.5, 0.12)).connect(ctx.destination);
    noise.start(0);
    tone.start(0);
    tone.stop(0.25);
  },
};

const hat: SampleSpec = {
  id: "hat",
  durationSec: 0.09,
  render(ctx) {
    const noise = noiseSource(ctx, 0.09);
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 7500;
    noise.connect(high).connect(decay(ctx, 0.55, 0.06)).connect(ctx.destination);
    noise.start(0);
  },
};

const openHat: SampleSpec = {
  id: "openhat",
  durationSec: 0.34,
  render(ctx) {
    const noise = noiseSource(ctx, 0.34);
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 6800;
    noise.connect(high).connect(decay(ctx, 0.45, 0.3)).connect(ctx.destination);
    noise.start(0);
  },
};

const clap: SampleSpec = {
  id: "clap",
  durationSec: 0.3,
  render(ctx) {
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1500;
    band.Q.value = 1.2;
    band.connect(ctx.destination);

    // Three tight bursts and a tail: a clap is a small crowd, not one hit.
    for (const [offset, level, length] of [
      [0, 0.7, 0.02],
      [0.012, 0.85, 0.02],
      [0.026, 1, 0.03],
    ] as const) {
      const burst = noiseSource(ctx, length);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level, offset);
      gain.gain.exponentialRampToValueAtTime(0.0001, offset + length);
      burst.connect(gain).connect(band);
      burst.start(offset);
    }

    const tail = noiseSource(ctx, 0.28);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.35, 0.03);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, 0.28);
    tail.connect(tailGain).connect(band);
    tail.start(0.03);
  },
};

const rim: SampleSpec = {
  id: "rim",
  durationSec: 0.08,
  render(ctx) {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 420;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2400;
    band.Q.value = 3;
    osc.connect(band).connect(decay(ctx, 0.6, 0.06)).connect(ctx.destination);
    osc.start(0);
    osc.stop(0.08);
  },
};

/** Bright plucked voice — the HIGH register of the audience. */
const pluck: SampleSpec = {
  id: "pluck",
  durationSec: 0.9,
  baseFreq: BASE_FREQ,
  render(ctx) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(6000, 0);
    filter.frequency.exponentialRampToValueAtTime(900, 0.5);
    filter.Q.value = 2;
    filter.connect(decay(ctx, 0.8, 0.85)).connect(ctx.destination);

    // Two saws a few cents apart: the beating is what stops fifty phones
    // playing the same note from sounding like one very loud phone.
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = BASE_FREQ * 2;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(0);
      osc.stop(0.9);
    }
  },
};

/** Warm sustained voice — the MID register. */
const pad: SampleSpec = {
  id: "pad",
  durationSec: 1.6,
  baseFreq: BASE_FREQ,
  render(ctx) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2200;
    filter.Q.value = 0.8;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, 0);
    envelope.gain.exponentialRampToValueAtTime(0.7, 0.18);
    envelope.gain.setValueAtTime(0.7, 1.1);
    envelope.gain.exponentialRampToValueAtTime(0.0001, 1.55);

    filter.connect(envelope).connect(ctx.destination);
    for (const [type, detune, level] of [
      ["sawtooth", -8, 0.5],
      ["triangle", 0, 0.6],
      ["sawtooth", 9, 0.5],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = BASE_FREQ;
      osc.detune.value = detune;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc.connect(gain).connect(filter);
      osc.start(0);
      osc.stop(1.6);
    }
  },
};

/** The one-shot a musician fires from the pad. */
const spark: SampleSpec = {
  id: "spark",
  durationSec: 0.7,
  baseFreq: BASE_FREQ,
  render(ctx) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(BASE_FREQ * 4, 0);
    osc.frequency.exponentialRampToValueAtTime(BASE_FREQ * 2, 0.25);

    const shimmer = noiseSource(ctx, 0.12);
    const shimmerFilter = ctx.createBiquadFilter();
    shimmerFilter.type = "bandpass";
    shimmerFilter.frequency.value = 5200;

    osc.connect(decay(ctx, 0.7, 0.65)).connect(ctx.destination);
    shimmer.connect(shimmerFilter).connect(decay(ctx, 0.3, 0.12)).connect(ctx.destination);
    osc.start(0);
    osc.stop(0.7);
    shimmer.start(0);
  },
};

/** Everything the maestro's drum machine can put on a track. */
export const MAESTRO_VOICES: readonly SampleSpec[] = [kick, snare, hat, openHat, clap, rim];

/** What a musician's phone renders, by register. Keeping the palette in the
 * bundle (rather than fetching per group) is what makes a hot group change a
 * crossfade instead of a download — §9.3. */
export const MUSICIAN_VOICES: readonly SampleSpec[] = [pluck, pad, spark];

export const ALL_VOICES: readonly SampleSpec[] = [...MAESTRO_VOICES, ...MUSICIAN_VOICES];

/** The sustained voice a group plays, by group id. */
export function groupVoiceId(group: number): string {
  return group === 1 ? "pluck" : "pad";
}

/**
 * Default tracks of the maestro's sequencer, in display order.
 *
 * `bass` is the odd one out: it has no `SampleSpec` and is absent from
 * `MAESTRO_VOICES`, because it is synthesised per note rather than loaded (see
 * `acidBass.ts`). A `pitched` lane reads the note of each cell instead of
 * playing at one fixed pitch.
 */
export const DEFAULT_TRACKS: readonly {
  trackId: string;
  sampleId: string;
  label: string;
  pitched?: boolean;
}[] = [
  { trackId: "kick", sampleId: "kick", label: "KICK" },
  { trackId: "snare", sampleId: "snare", label: "SNARE" },
  { trackId: "clap", sampleId: "clap", label: "CLAP" },
  { trackId: "hat", sampleId: "hat", label: "HAT" },
  { trackId: "openhat", sampleId: "openhat", label: "OPEN" },
  { trackId: "rim", sampleId: "rim", label: "RIM" },
  { trackId: "bass", sampleId: "acid", label: "BASS", pitched: true },
];
