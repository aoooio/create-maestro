/**
 * The lookahead scheduler of §5.3: an imprecise timer driving a precise
 * scheduler.
 *
 * Every 25 ms it asks the timeline which steps fall in the next 150 ms,
 * converts each one to a time on the audio clock, and hands it to the sink,
 * which starts a source *at that time*. There is never a bare `start()`.
 *
 * It also owns the replanning rule of §5.4: when the server announces a
 * transport change, everything already scheduled beyond the boundary is
 * cancelled and planned again against the new anchor.
 */

import { settle, stepsBetweenTimeline, type Timeline } from "@/domain/transport";
import type { StepEvent } from "@/domain/types";

/** Tick period of the driving timer (§5.3). */
export const TICK_INTERVAL_MS = 25;
/** How far ahead steps are planned (§5.3). */
export const LOOKAHEAD_MS = 150;

/** Where scheduled steps go. Implemented by the audio engine, faked in tests. */
export interface ScheduleSink {
  schedule(event: StepEvent, audioTime: number): void;
  /** Cancels everything already scheduled at or after an instant of server
   * time — the replanning half of a tempo change. */
  cancelFrom(serverMs: number): void;
}

/** A repeating tick. The Worker implementation survives tab throttling; the
 * timeout one is the fallback where Workers are unavailable. */
export interface TickSource {
  start(onTick: () => void): void;
  stop(): void;
}

/** Drives ticks from a Worker so a backgrounded tab keeps its period. Falls
 * back to `setInterval` when Workers are not available (older WebViews, SSR). */
export class WorkerTickSource implements TickSource {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly intervalMs: number = TICK_INTERVAL_MS) {}

  start(onTick: () => void): void {
    this.stop();
    try {
      this.worker = new Worker(new URL("./scheduler.worker.ts", import.meta.url));
      this.worker.onmessage = () => onTick();
      this.worker.postMessage({ type: "start", intervalMs: this.intervalMs });
      return;
    } catch {
      this.worker = null;
    }
    this.timer = setInterval(onTick, this.intervalMs);
  }

  stop(): void {
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Plain-timer tick source, used as a fallback and in tests. */
export class TimerTickSource implements TickSource {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly intervalMs: number = TICK_INTERVAL_MS) {}

  start(onTick: () => void): void {
    this.stop();
    this.timer = setInterval(onTick, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface LookaheadSchedulerOptions {
  serverNow: () => number;
  timeline: () => Timeline;
  /** Called with a settled timeline so the store can drop what is now past. */
  onSettled?: (timeline: Timeline) => void;
  /** Server time → audio time, output latency already compensated. */
  toAudioTime: (serverMs: number) => number;
  sink: ScheduleSink;
  tick: TickSource;
  lookaheadMs?: number;
}

export class LookaheadScheduler {
  private lastScheduledMs = Number.NEGATIVE_INFINITY;
  private running = false;
  private readonly lookaheadMs: number;

  constructor(private readonly options: LookaheadSchedulerOptions) {
    this.lookaheadMs = options.lookaheadMs ?? LOOKAHEAD_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Nothing before now is worth planning: after a pause the cursor would
    // otherwise try to catch up on every step it missed.
    this.lastScheduledMs = this.options.serverNow() - 1;
    this.options.tick.start(() => this.onTick());
  }

  stop(): void {
    this.running = false;
    this.options.tick.stop();
  }

  /**
   * A transport change lands at `effectiveAtServerMs`: anything already sent to
   * the audio graph beyond that instant was planned against the wrong anchor
   * and has to go (§5.4).
   */
  replanFrom(effectiveAtServerMs: number): void {
    this.options.sink.cancelFrom(effectiveAtServerMs);
    this.lastScheduledMs = Math.min(this.lastScheduledMs, effectiveAtServerMs - 1);
  }

  /** Exposed for tests and for a manual catch-up after resuming audio. */
  onTick(): void {
    const now = this.options.serverNow();
    const timeline = this.options.timeline();

    const from = Math.max(now, this.lastScheduledMs);
    const to = now + this.lookaheadMs;
    for (const event of stepsBetweenTimeline(timeline, from, to)) {
      if (event.serverMs <= this.lastScheduledMs) continue;
      this.options.sink.schedule(event, this.options.toAudioTime(event.serverMs));
      this.lastScheduledMs = event.serverMs;
    }

    const settled = settle(timeline, now);
    if (settled !== timeline) this.options.onSettled?.(settled);
  }
}
