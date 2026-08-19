/**
 * Bridging the system clock to the audio clock (§5.2).
 *
 * `AudioContext.currentTime` and `performance.now()` are two independent
 * clocks that drift apart — different sources, different resolutions, and the
 * audio one stalls while a device is interrupted. Scheduling against a stale
 * mapping is how a phone ends up a beat behind everyone else, so the anchor is
 * refreshed every couple of seconds.
 *
 * The second half of this file is the part people forget: `start(t)` asks for
 * the buffer to *begin* at `t`, but the sound leaves the speaker one output
 * buffer later. Subtracting `outputLatency + baseLatency` is what makes the
 * sound land on the beat rather than the scheduling.
 */

/** The slice of `AudioContext` this needs — so it can be tested with a fake. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

export interface AudioClockOptions {
  context: AudioContextLike;
  /** Client→server offset, from `ClockSync`. */
  offsetMs: () => number;
  /** Monotonic client clock, i.e. `performance.now()`. */
  now: () => number;
}

/** How often the anchor is re-taken (§5.2). */
const ANCHOR_REFRESH_MS = 2000;
/** Used when the browser will not tell us its output latency. Roughly one
 * 128-frame quantum at 44.1 kHz plus a typical device buffer — being 20 ms out
 * is far better than assuming zero. */
const FALLBACK_OUTPUT_LATENCY_SEC = 0.02;

export class AudioClock {
  private anchor: { perfMs: number; audioSec: number };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: AudioClockOptions) {
    this.anchor = this.sample();
  }

  start(): void {
    if (this.timer !== null) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), ANCHOR_REFRESH_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-takes the anchor. Also worth calling after a device interruption,
   * where the audio clock has been frozen while the system clock kept going. */
  refresh(): void {
    this.anchor = this.sample();
  }

  /** Converts an instant of server time into a time on the audio clock. */
  serverMsToAudioTime(serverMs: number): number {
    const perfMs = serverMs - this.options.offsetMs();
    return this.anchor.audioSec + (perfMs - this.anchor.perfMs) / 1000;
  }

  /** The instant a source must be started so the sound *leaves* at `serverMs`. */
  startTimeFor(serverMs: number): number {
    return this.serverMsToAudioTime(serverMs) - this.outputLatencySec();
  }

  outputLatencySec(): number {
    const { baseLatency, outputLatency } = this.options.context;
    const total = (outputLatency ?? 0) + (baseLatency ?? 0);
    return total > 0 ? total : FALLBACK_OUTPUT_LATENCY_SEC;
  }

  private sample(): { perfMs: number; audioSec: number } {
    // `getOutputTimestamp` gives a matched pair of the two clocks, which is
    // strictly better than reading them one after the other; not every engine
    // implements it, and some return zeroes before the context has run.
    const timestamp = this.options.context.getOutputTimestamp?.();
    const contextTime = timestamp?.contextTime;
    const performanceTime = timestamp?.performanceTime;
    if (
      contextTime !== undefined &&
      performanceTime !== undefined &&
      contextTime > 0 &&
      performanceTime > 0
    ) {
      return { perfMs: performanceTime, audioSec: contextTime };
    }
    return { perfMs: this.options.now(), audioSec: this.options.context.currentTime };
  }
}
