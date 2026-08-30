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
import { groupTrackId } from "@/domain/scale";
import type { GroupId, ParameterTarget, Role, Step } from "@/domain/types";
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
  restartPlaybackKeepAlive,
  startPlaybackKeepAlive,
  stopPlaybackKeepAlive,
} from "@/infrastructure/audio/unlock";
import type { GroupSynthSettings } from "@/infrastructure/audio/groupSynth";
import {
  DEFAULT_TRACKS,
  MAESTRO_VOICES,
  MUSICIAN_VOICES,
  type SampleSpec,
} from "@/infrastructure/audio/voices";
import { CLIENT_VERSION } from "@/infrastructure/config";
import { WsClient, type ConnectionState } from "@/infrastructure/ws/client";
import type { ServerMessage, TriggerRelay } from "@/infrastructure/ws/codec";

import { useAudioStore } from "./store/audioStore";
import { useSessionStore } from "./store/sessionStore";
import {
  combineVoicings,
  maestroVoicing,
  musicianVoicing,
  triggerNote,
  type Voicing,
} from "./voicing";

/** How long a disconnection may last before the sound stops claiming to be in
 * time with a room it can no longer hear (§6.5). */
const OFFLINE_FADE_AFTER_MS = 30_000;
const OFFLINE_FADE_SEC = 4;

/**
 * How loud a monitored group layer sits on the maestro's own output. Below the
 * base music on purpose: it is there to be checked against the drums, not to
 * take their place.
 */
const MONITOR_LEVEL = 0.55;

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
  private keepAlive: HTMLAudioElement | null = null;
  private graphReady = false;
  private unsubscribe: (() => void) | null = null;
  private faded = false;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SessionControllerOptions) {
    this.clock = new ClockSync({
      now: () => performance.now(),
      // Deliberately not coalesced: the initial burst is twelve samples in a
      // second and a half, and collapsing them onto one would leave the
      // estimate with nothing to take a median of. A ping delayed by the
      // outbound budget simply measures as a slow round trip, which the filter
      // already knows to throw away.
      sendPing: (clientSendMs) => this.ws.send({ t: "time.ping", d: { clientSendMs } }),
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
   *
   * The AudioContext, `resume()`, and the silent keep-alive must all be
   * *invoked* before the first `await`. Yielding first spends iOS's user
   * activation and leaves the context suspended.
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
    this.keepAlive = startPlaybackKeepAlive();
    const resumed = context.resume();
    this.bindInterruption(context);
    await resumed;

    if (context.state !== "running") {
      audio.setNeedsResume(true);
    }

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
    this.graphReady = true;
    this.markRunningOrBlocked();
  }

  /** Must be called from a tap: iOS will not resume a context any other way. */
  async resumeAudio(): Promise<void> {
    const context = this.context;
    if (!context || context.state === "closed") return;
    restartPlaybackKeepAlive(this.keepAlive);
    await context.resume();
    if (context.state === "running") {
      this.audioClock?.refresh();
      this.markRunningOrBlocked();
    }
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
          note: steps.map((step) => step.note),
        },
      },
      `pattern.set:${trackId}`,
    );
  }

  // --- musician commands ---

  /**
   * The one parameter a musician controls (§6.3). It is strictly local —
   * `param.set` is maestro-only, so this never touches the wire. It moves the
   * cutoff *within* the ceiling the maestro has set: authority stays where the
   * protocol puts it, and the gesture still changes the sound in the hand.
   */
  setLocalParam(value: number): void {
    useAudioStore.getState().setLocalParam(Math.min(1, Math.max(0, value)));
    this.applyAllParameters();
  }

  // --- maestro monitoring ---

  /**
   * Audition a group's layer on this console, or stop. Local in the same way
   * the musician's own parameter is: nothing goes on the wire, and the room
   * hears no difference.
   *
   * It goes through the controller rather than straight to the store because
   * the store is not what makes sound — the engine is, and only
   * `applyAllParameters` pushes the timbre and the monitor level into it. A UI
   * that flipped the store alone would leave the button lit and the console
   * silent until the next server message happened along.
   */
  toggleMonitor(group: GroupId): void {
    useAudioStore.getState().toggleMonitor(group);
    this.applyAllParameters();
  }

  /** A gesture from the pad: heard locally at once, and reported to the
   * maestro. The server relays it; it never comes back as sound. */
  sendTrigger(kind: string, intensity: number): void {
    const clamped = Math.min(1, Math.max(0, intensity));
    const group = useSessionStore.getState().groupId;
    void this.resumeAudio();
    this.engine?.fire(triggerNote(group, clamped));
    this.ws.send({ t: "trigger", d: { kind, intensity: clamped } });
  }

  dispose(): void {
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unsubscribe?.();
    this.scheduler?.stop();
    this.audioClock?.stop();
    this.clock.stop();
    this.ws.close();
    this.engine?.dispose();
    stopPlaybackKeepAlive(this.keepAlive);
    this.keepAlive = null;
    void this.context?.close();
    this.context = null;
    this.graphReady = false;
  }

  // --- internals ---

  private bindInterruption(context: AudioContext): void {
    // iOS suspends on an incoming call and never resumes on its own. A
    // `resume()` here without a gesture fails on WebKit; desktop still
    // recovers. The overlay is what actually brings a phone back.
    context.addEventListener("statechange", () => {
      if (context.state === "running") {
        this.audioClock?.refresh();
        this.markRunningOrBlocked();
        return;
      }
      if (context.state === "closed") return;
      useAudioStore.getState().setNeedsResume(true);
      void context.resume();
    });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== "visible") return;
    const context = this.context;
    if (!context || context.state === "closed" || context.state === "running") return;
    useAudioStore.getState().setNeedsResume(true);
  };

  private markRunningOrBlocked(): void {
    const context = this.context;
    const audio = useAudioStore.getState();
    if (!context || context.state === "closed") return;
    if (context.state === "running") {
      audio.setNeedsResume(false);
      if (this.graphReady && audio.stage !== "failed") audio.setStage("ready");
      return;
    }
    audio.setNeedsResume(true);
  }

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
    // ROOT transposes every pitched line — the acid bass and the group strips
    // alike — so that the whole room stays in one key. It reaches the sound
    // through the voicing rather than the graph, so turning it rebuilds this,
    // which `applyAllParameters` and the store subscription already do.
    const transpose = Number(effectiveParameter(state.params, "bassRoot", 0));

    if (this.options.role === "maestro") {
      const base = maestroVoicing(state.patterns, DEFAULT_TRACKS, { transpose });
      const monitored = useAudioStore.getState().monitorGroups;
      if (monitored.size === 0) return base;
      // The console runs the very function the phones run, rather than a
      // second rendering of "what a group probably plays" — so what the
      // maestro auditions is what the room hears.
      return combineVoicings(
        base,
        ...[...monitored].map((group) => this.groupVoicing(group, transpose)),
      );
    }

    return this.groupVoicing(state.groupId || 1, transpose);
  }

  /** The layer of one group, as every phone of that group renders it. */
  private groupVoicing(group: GroupId, transpose: number): Voicing {
    const state = useSessionStore.getState();
    return musicianVoicing({
      group,
      density: Number(effectiveParameter(state.params, "density", group)),
      strip: state.patterns.get(groupTrackId(group)),
      transpose,
    });
  }

  /** The six values a group's voice is built from, as they stand right now. */
  private synthSettings(group: GroupId): GroupSynthSettings {
    const params = useSessionStore.getState().params;
    const read = (key: ParameterKey) => Number(effectiveParameter(params, key, group));
    return {
      wave: read("synthWave"),
      spread: read("synthSpread"),
      attack: read("synthAttack"),
      release: read("synthRelease"),
      brightness: read("synthBrightness"),
      octave: read("synthOctave"),
    };
  }

  /** Pushes the parameters in force for this client into the graph. A musician
   * takes the group scope; the maestro hears the session scope. */
  private applyAllParameters(): void {
    if (!this.engine) return;
    const state = useSessionStore.getState();
    const maestro = this.options.role === "maestro";
    const group = maestro ? 0 : state.groupId;
    for (const key of [
      "resonance",
      "gain",
      "reverb",
      "delay",
      "mute",
      // The acid bass sounds on the maestro's own output, but its settings are
      // read from the same scope as everything else so a musician build that
      // ever gained the voice would need no new path.
      "bassCutoff",
      "bassResonance",
      "bassEnvMod",
      "bassDecay",
      "bassAccent",
    ] as const) {
      this.engine.setParameter(key, effectiveParameter(state.params, key, group));
    }

    // The maestro's cutoff is a ceiling; a musician's own control moves inside it.
    const cutoff = Number(effectiveParameter(state.params, "cutoff", group));
    const local = useAudioStore.getState().localParam;
    this.engine.setParameter("cutoff", maestro ? cutoff : cutoff * (0.25 + 0.75 * local));

    this.applySynthSettings(maestro, state.groupId);
    // `density` shapes what is played rather than how it sounds.
    this.refreshVoicing();
  }

  /**
   * The timbre of each group layer this client renders, plus — on the console
   * — how loud each of them is monitored. A musician builds one voice, their
   * own; the maestro may be auditioning several, and each has to sound as its
   * own strip on screen says it will.
   */
  private applySynthSettings(maestro: boolean, ownGroup: GroupId): void {
    if (!this.engine) return;
    if (!maestro) {
      this.engine.setSynth(ownGroup || 1, this.synthSettings(ownGroup || 1));
      return;
    }

    const monitored = useAudioStore.getState().monitorGroups;
    for (const { id } of useSessionStore.getState().groups) {
      this.engine.setSynth(id, this.synthSettings(id));
      // Silencing an unmonitored lane rather than skipping it: a group the
      // maestro has just switched off must stop sounding, not keep the level
      // it had.
      this.engine.setTrackGain(groupTrackId(id), monitored.has(id) ? MONITOR_LEVEL : 0);
    }
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
