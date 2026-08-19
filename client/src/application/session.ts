/**
 * The composition root of a live session: one object that owns the socket, the
 * clock, the audio graph and the scheduler, and keeps the two stores in step
 * with them.
 *
 * It exists so that no React component ever holds a socket or an
 * `AudioContext`. Components read stores and call methods here; everything
 * with a lifetime longer than a render lives in this class.
 */

import { effectiveParameter, type ParameterKey } from "@/domain/parameter";
import { clampBpm, nextBarBoundary, transportAt } from "@/domain/transport";
import type { ParameterTarget, Role, Step } from "@/domain/types";
import { formatTarget } from "@/domain/group";
import { AudioClock } from "@/infrastructure/clock/audioClock";
import { ClockSync } from "@/infrastructure/clock/clockSync";
import {
  LookaheadScheduler,
  WorkerTickSource,
  type TickSource,
} from "@/infrastructure/clock/scheduler";
import { AudioEngine } from "@/infrastructure/audio/engine";
import { loadSamples, type SampleBank } from "@/infrastructure/audio/sampleLoader";
import {
  DEFAULT_TRACKS,
  MAESTRO_VOICES,
  MUSICIAN_VOICES,
  groupVoiceId,
  type SampleSpec,
} from "@/infrastructure/audio/voices";
import { CLIENT_VERSION } from "@/infrastructure/config";
import { WsClient, type ConnectionState } from "@/infrastructure/ws/client";
import type { ServerMessage, TriggerRelay } from "@/infrastructure/ws/codec";

import { useAudioStore } from "./store/audioStore";
import { useSessionStore } from "./store/sessionStore";
import { maestroVoicing, musicianVoicing, triggerNote, type Voicing } from "./voicing";

/** How long a disconnection may last before the sound stops claiming to be in
 * time with a room it can no longer hear (§6.5). */
const OFFLINE_FADE_AFTER_MS = 30_000;
const OFFLINE_FADE_SEC = 4;

export interface SessionControllerOptions {
  url: string;
  role: Role;
  name?: string;
  /** Ephemeral gestures, delivered straight to the animation layer: putting
   * two hundred triggers a second through React state would be absurd. */
  onTrigger?: (trigger: TriggerRelay) => void;
  /** Test seam: a tick source that does not need a Worker. */
  tickSource?: TickSource;
}

export class SessionController {
  private readonly ws: WsClient;
  private readonly clock: ClockSync;
  private audioClock: AudioClock | null = null;
  private engine: AudioEngine | null = null;
  private scheduler: LookaheadScheduler | null = null;
  private context: AudioContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private faded = false;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SessionControllerOptions) {
    this.clock = new ClockSync({
      now: () => performance.now(),
      sendPing: (clientSendMs) =>
        this.ws.send({ t: "time.ping", d: { clientSendMs } }, "time.ping"),
      onUpdate: (state) =>
        useAudioStore.getState().setSync({
          quality: state.quality,
          offsetMs: state.offsetMs,
          rttMs: state.rttMs,
          samples: state.samples,
        }),
    });

    this.ws = new WsClient({
      url: options.url,
      hello: {
        name: options.name,
        clientVersion: CLIENT_VERSION,
        capabilities: {
          webaudio: useAudioStore.getState().hasWebAudio,
          webgl: useAudioStore.getState().hasWebGL,
        },
      },
      onMessage: (message) => this.onMessage(message),
      onStateChange: (state, detail) => this.onConnectionChange(state, detail?.attempt ?? 0),
      onHandshake: () => this.clock.resync(),
      onFatal: (reason, message) => useSessionStore.getState().setFatal(reason, message),
    });
  }

  connect(): void {
    this.clock.start();
    this.ws.connect();
    // The voicing follows the state: patterns for the maestro, the group's
    // density for a musician. Rebuilt on change rather than on every step.
    this.unsubscribe = useSessionStore.subscribe(() => this.refreshVoicing());
  }

  /** Server time now — the single instant everything in the room agrees on. */
  serverNowMs(): number {
    return this.clock.serverNowMs();
  }

  clockReady(): boolean {
    return this.clock.isReady();
  }

  connectionState(): ConnectionState {
    return this.ws.getState();
  }

  pendingMessages(): number {
    return this.ws.pending();
  }

  /** Live output level for the wireframe scene, 0..1. */
  level(buffer: Uint8Array): number {
    return this.engine?.readLevel(buffer) ?? 0;
  }

  analyser(): AnalyserNode | null {
    return this.engine?.analyser ?? null;
  }

  /**
   * Everything that needs a user gesture, in the order the platform demands:
   * create the context inside the handler, resume it, then load. Audio is not
   * allowed to start before the clock burst has settled (§5.1) — a phone that
   * starts early is a phone that starts wrong.
   */
  async startAudio(): Promise<void> {
    const audio = useAudioStore.getState();
    if (this.context) return;

    audio.setStage("unlocking");
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      audio.setCapabilities({ hasWebAudio: false, hasWebGL: audio.hasWebGL });
      audio.fail("Web Audio indisponible — mode spectateur");
      return;
    }

    const context = new Ctor();
    this.context = context;
    await context.resume();

    // iOS suspends the context on an incoming call and never resumes it on its
    // own; the anchor is also stale after the gap, so both are handled here.
    context.addEventListener("statechange", () => {
      if (context.state === "suspended") void context.resume();
      if (context.state === "running") this.audioClock?.refresh();
    });

    audio.setStage("loading");
    let bank: SampleBank;
    try {
      bank = await loadSamples(context, this.voiceSpecs(), {
        onProgress: (ratio) => audio.setProgress(ratio),
      });
    } catch (error) {
      audio.fail(error instanceof Error ? error.message : "chargement impossible");
      return;
    }

    this.engine = new AudioEngine(context, bank);
    this.audioClock = new AudioClock({
      context,
      offsetMs: () => this.clock.offset(),
      now: () => performance.now(),
    });
    this.audioClock.start();

    this.scheduler = new LookaheadScheduler({
      serverNow: () => this.clock.serverNowMs(),
      timeline: () => useSessionStore.getState().timeline,
      onSettled: () =>
        useSessionStore.getState().settleTimeline(this.clock.serverNowMs()),
      toAudioTime: (serverMs) => this.audioClock!.startTimeFor(serverMs),
      sink: this.engine,
      tick: this.options.tickSource ?? new WorkerTickSource(),
    });

    this.refreshVoicing();
    this.applyAllParameters();

    // The burst has to have produced an estimate before a single note is
    // planned, or the first bar lands wherever this phone happens to think it is.
    await this.waitForClock();
    this.scheduler.start();
    audio.setStage("ready");
  }

  // --- maestro commands ---

  setTransport(command: {
    bpm?: number;
    state?: "playing" | "stopped";
    beatsPerBar?: number;
    stepsPerBeat?: number;
    alignTo?: "bar" | "immediate";
  }): void {
    const payload = {
      ...command,
      bpm: command.bpm === undefined ? undefined : clampBpm(command.bpm),
      alignTo: command.alignTo ?? ("bar" as const),
    };
    // Coalesced: a dial being turned sends its latest value, not all of them.
    this.ws.send({ t: "transport.set", d: payload }, "transport.set");
  }

  setParameter(key: ParameterKey, value: number | boolean, target: ParameterTarget): void {
    this.ws.send(
      { t: "param.set", d: { key, value, target: formatTarget(target) } },
      `param.set:${key}:${formatTarget(target)}`,
    );
  }

  setPattern(trackId: string, steps: readonly Step[]): void {
    this.ws.send(
      {
        t: "pattern.set",
        d: {
          trackId,
          steps: steps.map((step) => step.on),
          velocity: steps.map((step) => step.velocity),
        },
      },
      `pattern.set:${trackId}`,
    );
  }

  // --- musician commands ---

  /** A gesture from the pad: heard locally at once, and reported to the
   * maestro. The server relays it; it never comes back as sound. */
  sendTrigger(kind: string, intensity: number): void {
    const clamped = Math.min(1, Math.max(0, intensity));
    const group = useSessionStore.getState().groupId;
    this.engine?.fire(triggerNote(group, clamped));
    this.ws.send({ t: "trigger", d: { kind, intensity: clamped } });
  }

  dispose(): void {
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.unsubscribe?.();
    this.scheduler?.stop();
    this.audioClock?.stop();
    this.clock.stop();
    this.ws.close();
    this.engine?.dispose();
    void this.context?.close();
    this.context = null;
  }

  // --- internals ---

  private voiceSpecs(): readonly SampleSpec[] {
    return this.options.role === "maestro" ? MAESTRO_VOICES : MUSICIAN_VOICES;
  }

  private onMessage(message: ServerMessage): void {
    // The clock and the ephemeral events are handled first: neither belongs in
    // the protocol state, and both are on the hot path.
    if (message.type === "time.pong") {
      this.clock.onPong(message.data);
      return;
    }
    if (message.type === "participant.trigger") {
      this.options.onTrigger?.(message.data);
      return;
    }

    useSessionStore.getState().apply(message);

    switch (message.type) {
      case "transport.updated":
        // Whatever was already in the audio graph past the boundary was placed
        // against the old anchor (§5.4).
        this.scheduler?.replanFrom(message.data.effectiveAtServerMs);
        return;
      case "param.updated":
      case "state.snapshot":
        this.applyAllParameters();
        return;
      case "group.assigned":
        this.refreshVoicing();
        this.applyAllParameters();
        return;
      default:
        return;
    }
  }

  private onConnectionChange(state: ConnectionState, attempt: number): void {
    useSessionStore.getState().setConnection(state, attempt);

    if (state === "open") {
      useAudioStore.getState().setOffline(false);
      if (this.faded) this.restoreAtNextBar();
      return;
    }
    if (state === "reconnecting" || state === "closed") {
      useAudioStore.getState().setOffline(true);
      this.scheduleFadeCheck();
    }
  }

  /** During an outage the local clock is enough to keep playing (§6.5); past
   * half a minute, playing on is a claim we can no longer back. */
  private scheduleFadeCheck(): void {
    if (this.faded || this.restoreTimer !== null) return;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      const offlineFor = this.ws.offlineForMs();
      if (offlineFor === null) return;
      if (offlineFor >= OFFLINE_FADE_AFTER_MS) {
        this.faded = true;
        this.engine?.fadeTo(0, OFFLINE_FADE_SEC);
        return;
      }
      this.scheduleFadeCheck();
    }, 2000);
  }

  /** Coming back mid-bar would put this phone half a beat off the room; the
   * sound returns on a bar line (§6.5). */
  private restoreAtNextBar(): void {
    const now = this.clock.serverNowMs();
    const timeline = useSessionStore.getState().timeline;
    const at = nextBarBoundary(transportAt(timeline, now), now);
    this.faded = false;
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(
      () => {
        this.restoreTimer = null;
        this.engine?.restoreLevel();
      },
      Math.max(0, at - now),
    );
  }

  private refreshVoicing(): void {
    if (!this.engine) return;
    this.engine.setVoicing(this.buildVoicing());
  }

  private buildVoicing(): Voicing {
    const state = useSessionStore.getState();
    if (this.options.role === "maestro") {
      return maestroVoicing(state.patterns, DEFAULT_TRACKS);
    }
    const group = state.groupId || 1;
    return musicianVoicing({
      group,
      density: Number(effectiveParameter(state.params, "density", group)),
      sampleId: groupVoiceId(group),
    });
  }

  /** Pushes the parameters in force for this client into the graph. A musician
   * takes the group scope; the maestro hears the session scope. */
  private applyAllParameters(): void {
    if (!this.engine) return;
    const state = useSessionStore.getState();
    const group = this.options.role === "maestro" ? 0 : state.groupId;
    for (const key of ["cutoff", "resonance", "gain", "reverb", "delay", "mute"] as const) {
      this.engine.setParameter(key, effectiveParameter(state.params, key, group));
    }
    // `density` shapes what is played rather than how it sounds.
    this.refreshVoicing();
  }

  private async waitForClock(): Promise<void> {
    if (this.clock.isReady()) return;
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 8000;
      const poll = setInterval(() => {
        // Past the deadline we start anyway: a musician staring at a stuck
        // progress bar is worse than one who is 30 ms out and converging.
        if (this.clock.isReady() || Date.now() > deadline) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  }
}
