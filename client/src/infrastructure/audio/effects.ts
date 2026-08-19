/**
 * The shared ends of the graph: the send effects and the thing that keeps a
 * room full of phones from clipping.
 */

/**
 * A `DynamicsCompressorNode` set up as a limiter (§6.4). This is not polish:
 * the musician layer is additive, the pad sustains, and a hall of phones each
 * a hair out of phase produces peaks no single voice predicts. Without a
 * ceiling the result is distortion on the loudest moment of the set.
 */
export function createLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
  return limiter;
}

/**
 * A synthetic impulse response: exponentially decaying noise, stereo, with the
 * two channels uncorrelated so the tail has width. Small, instant, and enough
 * for a send reverb — a real IR would be another file to fetch on venue Wi-Fi.
 */
export function createImpulseResponse(
  ctx: BaseAudioContext,
  seconds = 1.8,
  decay = 3.2,
): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, frames, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** decay;
    }
  }
  return impulse;
}

export interface SendChain {
  /** Where the dry signal is tapped from. */
  readonly input: GainNode;
  /** Wet level, driven by the `reverb` / `delay` parameters. */
  readonly wet: GainNode;
}

export function createReverbSend(ctx: BaseAudioContext, destination: AudioNode): SendChain {
  const input = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulseResponse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(convolver).connect(wet).connect(destination);
  return { input, wet };
}

export function createDelaySend(
  ctx: BaseAudioContext,
  destination: AudioNode,
  delaySeconds = 0.28,
  feedback = 0.35,
): SendChain {
  const input = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = delaySeconds;
  const loop = ctx.createGain();
  loop.gain.value = feedback;
  const wet = ctx.createGain();
  wet.gain.value = 0;

  input.connect(delay);
  delay.connect(loop).connect(delay);
  delay.connect(wet).connect(destination);
  return { input, wet };
}

/** Musical mapping of a 0..1 cutoff onto a filter frequency. Linear would
 * spend most of the travel above where anything audible happens. */
export function cutoffToHz(value: number): number {
  const min = 180;
  const max = 18_000;
  return min * (max / min) ** clamp01(value);
}

/** 0..1 resonance onto a filter Q that never self-oscillates. */
export function resonanceToQ(value: number): number {
  return 0.7 + clamp01(value) * 11;
}

/** Perceived loudness, not raw amplitude: a fader at half should sound half. */
export function gainToAmplitude(value: number): number {
  return clamp01(value) ** 2;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
