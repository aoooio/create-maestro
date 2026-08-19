/**
 * The Web Audio graph of §6.4:
 *
 *   source → voiceGain → trackGain → filter → groupBus → master → limiter → out
 *                                                  └→ analyser (visual)
 *                                                  └→ reverb / delay sends
 *
 * Three rules hold everywhere in this file:
 *
 *  - a source is always started *at a time*, never bare. The scheduler decides
 *    when; the engine only obeys;
 *  - every parameter change goes through `setTargetAtTime`. Assigning to
 *    `gain.value` while sound is passing through produces a click, and a
 *    hundred phones clicking together is a bang;
 *  - every source that has been started is remembered until it ends, because a
 *    tempo change has to be able to take back what was scheduled past the
 *    boundary (§5.4).
 */

import type { PlannedNote, Voicing } from "@/application/voicing";
import type { StepEvent } from "@/domain/types";
import type { ScheduleSink } from "@/infrastructure/clock/scheduler";

import {
  createDelaySend,
  createLimiter,
  createReverbSend,
  cutoffToHz,
  gainToAmplitude,
  resonanceToQ,
  type SendChain,
} from "./effects";
import type { SampleBank } from "./sampleLoader";

/** Smoothing constant for every parameter ramp: fast enough to feel immediate,
 * slow enough never to click. */
const PARAM_TAU = 0.03;
/** A one-shot still gets a start time — just a very near one. */
const IMMEDIATE_LEAD_SEC = 0.012;

interface Track {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
}

interface LiveSource {
  serverMs: number;
  source: AudioBufferSourceNode;
}

export class AudioEngine implements ScheduleSink {
  private readonly master: GainNode;
  private readonly bus: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly reverb: SendChain;
  private readonly delay: SendChain;
  private readonly tracks = new Map<string, Track>();
  private live: LiveSource[] = [];
  private voicing: Voicing = () => [];
  private cutoff = 1;
  private resonance = 0;
  private muted = false;
  private level = 0.8;

  readonly analyser: AnalyserNode;

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: SampleBank,
  ) {
    this.bus = ctx.createGain();
    this.master = ctx.createGain();
    this.limiter = createLimiter(ctx);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.75;

    this.bus.connect(this.master);
    this.master.connect(this.limiter).connect(ctx.destination);
    // The analyser only ever listens. The visual reads the audio; nothing in
    // the audio path ever reads the visual.
    this.bus.connect(this.analyser);

    this.reverb = createReverbSend(ctx, this.master);
    this.delay = createDelaySend(ctx, this.master);
    this.bus.connect(this.reverb.input);
    this.bus.connect(this.delay.input);

    this.master.gain.value = gainToAmplitude(this.level);
  }

  setVoicing(voicing: Voicing): void {
    this.voicing = voicing;
  }

  /** ScheduleSink: plan everything this step should sound. */
  schedule(event: StepEvent, audioTime: number): void {
    for (const note of this.voicing(event)) {
      this.play(note, audioTime, event.serverMs);
    }
  }

  /** ScheduleSink: take back everything planned at or after an instant — a
   * tempo change invalidated the anchor those notes were placed against. */
  cancelFrom(serverMs: number): void {
    const kept: LiveSource[] = [];
    for (const item of this.live) {
      if (item.serverMs >= serverMs) {
        try {
          item.source.stop();
        } catch {
          // Already finished, or never started: nothing to take back.
        }
        continue;
      }
      kept.push(item);
    }
    this.live = kept;
  }

  /** A gesture from the musician's pad: still scheduled, just very soon. */
  fire(note: PlannedNote): void {
    this.play(note, this.ctx.currentTime + IMMEDIATE_LEAD_SEC, Number.NEGATIVE_INFINITY);
  }

  private play(note: PlannedNote, audioTime: number, serverMs: number): void {
    const sample = this.bank.get(note.sampleId);
    if (!sample) return;

    // A time already past would make the browser start the source immediately,
    // dropping it a few milliseconds out of phase with everyone else. Better
    // to lose the note than to play it late.
    const when = Math.max(audioTime, this.ctx.currentTime);
    if (audioTime < this.ctx.currentTime - 0.05) return;

    const source = this.ctx.createBufferSource();
    source.buffer = sample.buffer;
    if (note.freq !== undefined && sample.baseFreq) {
      source.playbackRate.value = note.freq / sample.baseFreq;
    }

    const voiceGain = this.ctx.createGain();
    // Velocity is perceptual, like the faders: squaring keeps a soft hit soft.
    voiceGain.gain.value = Math.max(0, Math.min(1, note.velocity)) ** 2;

    source.connect(voiceGain).connect(this.track(note.trackId).gain);
    source.start(when);

    const entry: LiveSource = { serverMs, source };
    this.live.push(entry);
    source.onended = () => {
      this.live = this.live.filter((item) => item !== entry);
      source.disconnect();
      voiceGain.disconnect();
    };
  }

  private track(trackId: string): Track {
    const existing = this.tracks.get(trackId);
    if (existing) return existing;

    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoffToHz(this.cutoff);
    filter.Q.value = resonanceToQ(this.resonance);
    gain.connect(filter).connect(this.bus);

    const track: Track = { gain, filter };
    this.tracks.set(trackId, track);
    return track;
  }

  /** Applies one parameter of the domain registry. Unknown keys are ignored:
   * the server clamps and validates, and a key this build does not render yet
   * is not an error worth breaking playback over. */
  setParameter(key: string, value: number | boolean): void {
    const now = this.ctx.currentTime;
    switch (key) {
      case "gain":
        this.level = asNumber(value);
        this.applyMasterLevel();
        return;
      case "mute":
        this.muted = value === true || asNumber(value) !== 0;
        this.applyMasterLevel();
        return;
      case "cutoff":
        this.cutoff = asNumber(value);
        for (const track of this.tracks.values()) {
          track.filter.frequency.setTargetAtTime(cutoffToHz(this.cutoff), now, PARAM_TAU);
        }
        return;
      case "resonance":
        this.resonance = asNumber(value);
        for (const track of this.tracks.values()) {
          track.filter.Q.setTargetAtTime(resonanceToQ(this.resonance), now, PARAM_TAU);
        }
        return;
      case "reverb":
        this.reverb.wet.gain.setTargetAtTime(asNumber(value), now, PARAM_TAU);
        return;
      case "delay":
        this.delay.wet.gain.setTargetAtTime(asNumber(value), now, PARAM_TAU);
        return;
      default:
        // `density` shapes the voicing, not the graph.
        return;
    }
  }

  /** Fades the output rather than cutting it — used when a disconnection has
   * lasted long enough that playing on would be lying (§6.5). */
  fadeTo(level: number, seconds: number): void {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(level, now + seconds);
  }

  /** Restores the level the parameters call for, after a fade. */
  restoreLevel(seconds = 0.5): void {
    this.fadeTo(this.muted ? 0 : gainToAmplitude(this.level), seconds);
  }

  private applyMasterLevel(): void {
    const target = this.muted ? 0 : gainToAmplitude(this.level);
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, PARAM_TAU);
  }

  /** Live output level, 0..1, for the wireframe scene. */
  readLevel(buffer: Uint8Array): number {
    this.analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>);
    let peak = 0;
    for (const sample of buffer) {
      const deviation = Math.abs(sample - 128) / 128;
      if (deviation > peak) peak = deviation;
    }
    return peak;
  }

  dispose(): void {
    this.cancelFrom(Number.NEGATIVE_INFINITY);
    this.bus.disconnect();
    this.master.disconnect();
    this.limiter.disconnect();
    this.analyser.disconnect();
    for (const track of this.tracks.values()) {
      track.gain.disconnect();
      track.filter.disconnect();
    }
    this.tracks.clear();
  }
}

function asNumber(value: number | boolean): number {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}
