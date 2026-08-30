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
import type { GroupId, StepEvent } from "@/domain/types";
import type { ScheduleSink } from "@/infrastructure/clock/scheduler";

import { DEFAULT_ACID, playAcidNote, type AcidSettings } from "./acidBass";
import { DEFAULT_SYNTH, playSynthNote, type GroupSynthSettings } from "./groupSynth";
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
import type { StoppableVoice } from "./voice";

/** Smoothing constant for every parameter ramp: fast enough to feel immediate,
 * slow enough never to click. */
const PARAM_TAU = 0.03;
/** A one-shot still gets a start time — just a very near one. */
const IMMEDIATE_LEAD_SEC = 0.012;
/** Gate length for a sustained note fired outside the grid, where there is no
 * step to take a length from. */
const DEFAULT_GATE_SEC = 0.15;

interface Track {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
}

/** What the engine remembers about anything it has started. Both a sample
 * source and a synthesised acid note answer to `stop`, which is all a tempo
 * change needs of them. */
interface LiveSource {
  serverMs: number;
  source: StoppableVoice;
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
  private acid: AcidSettings = DEFAULT_ACID;
  /**
   * One timbre per group rather than one for the engine: a musician renders
   * only their own group, but the maestro monitors several at once and each
   * must sound as its own console strip says it will.
   */
  private readonly synths = new Map<GroupId, GroupSynthSettings>();

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
    // A time already past would make the browser start the source immediately,
    // dropping it a few milliseconds out of phase with everyone else. Better
    // to lose the note than to play it late.
    const when = Math.max(audioTime, this.ctx.currentTime);
    if (audioTime < this.ctx.currentTime - 0.05) return;

    // The synthesised voices are settled before the bank is consulted: there
    // is no buffer to find for either of them.
    if (note.voice === "acid") {
      this.playAcid(note, when, serverMs);
      return;
    }
    if (note.voice === "synth") {
      this.playSynth(note, when, serverMs);
      return;
    }

    const sample = note.sampleId === undefined ? undefined : this.bank.get(note.sampleId);
    if (!sample) return;

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

  /** One acid note, built for itself. It goes through the same track gain as
   * everything else, so the group bus, the sends and the limiter still see it. */
  private playAcid(note: PlannedNote, when: number, serverMs: number): void {
    if (note.freq === undefined) return;

    const voice: StoppableVoice = playAcidNote(
      this.ctx,
      this.track(note.trackId).gain,
      {
        when,
        freq: note.freq,
        velocity: note.velocity,
        accent: note.accent === true,
        durationSec: note.durationSec ?? DEFAULT_GATE_SEC,
      },
      this.acid,
      // Runs on `onended`, long after `voice` is bound. The voice disconnects
      // its own nodes; the engine only has to stop remembering it.
      () => {
        this.live = this.live.filter((item) => item.source !== voice);
      },
    );

    this.live.push({ serverMs, source: voice });
  }

  /**
   * One note of a group's layer. Built for itself, like the acid bass, and
   * routed through the same track gain — so the bus, the sends, the monitor
   * trim and the limiter all still see it.
   */
  private playSynth(note: PlannedNote, when: number, serverMs: number): void {
    if (note.freq === undefined) return;

    const settings = this.synths.get(note.group ?? 0) ?? DEFAULT_SYNTH;
    const voice: StoppableVoice = playSynthNote(
      this.ctx,
      this.track(note.trackId).gain,
      {
        when,
        freq: note.freq,
        velocity: note.velocity,
        accent: note.accent === true,
        durationSec: note.durationSec ?? DEFAULT_GATE_SEC,
      },
      settings,
      // Runs on `onended`, long after `voice` is bound. The voice disconnects
      // its own nodes; the engine only has to stop remembering it.
      () => {
        this.live = this.live.filter((item) => item.source !== voice);
      },
    );

    this.live.push({ serverMs, source: voice });
  }

  /**
   * The timbre a group's notes are built with. Read when a note is created,
   * not while one is sounding: no signal passes through the settings object,
   * so there is nothing to ramp and a plain assignment cannot click.
   */
  setSynth(group: GroupId, settings: GroupSynthSettings): void {
    this.synths.set(group, settings);
  }

  /**
   * Trim on one lane, ahead of the shared filter and bus. The maestro's
   * monitoring of a group layer rides on this: it changes what *this* console
   * hears and nothing else, which is why it is a gain here and not a
   * parameter on the wire.
   */
  setTrackGain(trackId: string, value: number): void {
    this.track(trackId).gain.gain.setTargetAtTime(
      Math.max(0, value),
      this.ctx.currentTime,
      PARAM_TAU,
    );
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
      // The acid settings are read when a note is built, not while one is
      // sounding: no signal passes through them, so there is nothing to ramp
      // and a plain assignment cannot click. `bassRoot` is not here at all —
      // it transposes the line, which is a decision the voicing makes.
      case "bassCutoff":
        this.acid = { ...this.acid, cutoff: asNumber(value) };
        return;
      case "bassResonance":
        this.acid = { ...this.acid, resonance: asNumber(value) };
        return;
      case "bassEnvMod":
        this.acid = { ...this.acid, envMod: asNumber(value) };
        return;
      case "bassDecay":
        this.acid = { ...this.acid, decay: asNumber(value) };
        return;
      case "bassAccent":
        this.acid = { ...this.acid, accent: asNumber(value) };
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
