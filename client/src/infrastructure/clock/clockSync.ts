/**
 * Estimating the offset between the client's monotonic clock and the server's
 * (§5.1) — the first of the three clocks that have to be reconciled before a
 * single note can be scheduled.
 *
 * The measurement is a simplified NTP round trip:
 *
 *     rtt    = (t3 - t0) - (serverSendMs - serverRecvMs)
 *     offset = ((serverRecvMs - t0) + (serverSendMs - t3)) / 2
 *
 * A single sample is worthless on Wi-Fi — one GC pause or one retransmission
 * and it is 80 ms out. What makes it usable is the filtering: keep the fastest
 * round trips, take the median of their offsets, and reject anything whose rtt
 * is more than twice the best one seen.
 *
 * Everything is injected (clock, ping transport, timers come from the host):
 * this class is tested against a simulated network, with no server and no DOM.
 */

export type SyncQuality = "unknown" | "good" | "fair" | "poor";

export interface ClockSample {
  readonly rttMs: number;
  readonly offsetMs: number;
  readonly atMs: number;
}

export interface ClockSyncState {
  readonly offsetMs: number;
  readonly rttMs: number;
  readonly quality: SyncQuality;
  readonly samples: number;
  readonly ready: boolean;
}

export interface PongInput {
  clientSendMs: number;
  serverRecvMs: number;
  serverSendMs: number;
}

export interface ClockSyncOptions {
  /** Monotonic client clock, i.e. `performance.now()`. */
  now: () => number;
  /** Puts one `time.ping` on the wire. */
  sendPing: (clientSendMs: number) => void;
  onUpdate?: (state: ClockSyncState) => void;
}

/** Initial burst, before audio is allowed to start (§5.1). */
const BURST_COUNT = 12;
const BURST_INTERVAL_MS = 120;
/** Maintenance rate once the burst has settled. */
const MAINTENANCE_INTERVAL_MS = 5000;

/** Samples kept for filtering, and how many of the fastest ones are used. */
const WINDOW = 12;
const BEST_SAMPLES = 3;
/** A round trip more than twice the best one is jitter, not information. */
const RTT_REJECT_FACTOR = 2;
/** Samples older than this are dropped. Without it a burst would sit in the
 * window forever and pin the median: the estimate would stop following a slow
 * drift, which is precisely what maintenance exists to catch. */
const MAX_SAMPLE_AGE_MS = 20_000;
/** Never prune below this many, however old they are. */
const MIN_SAMPLES = 3;

const EMA_ALPHA = 0.15;
/** Beyond this the offset is not drifting, it has moved: a network change or a
 * wake from sleep. Jump straight there and resync from scratch. */
const JUMP_THRESHOLD_MS = 150;
/** Beyond this we are outside the §5.4 drift budget: measure again sooner
 * rather than waiting for the next maintenance tick. */
const DRIFT_ALARM_MS = 40;
const DRIFT_RECHECK_MS = 400;

/** Quality thresholds, on the best round trip and the spread of the offsets. */
const GOOD_RTT_MS = 60;
const GOOD_SPREAD_MS = 10;
const FAIR_RTT_MS = 150;
const FAIR_SPREAD_MS = 30;

export class ClockSync {
  private samples: ClockSample[] = [];
  private offsetMs = 0;
  private rttMs = 0;
  private quality: SyncQuality = "unknown";
  private ready = false;
  private inFlight = new Set<number>();
  private burstLeft = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly options: ClockSyncOptions) {}

  /** Server time now: the whole point of this class. */
  serverNowMs(): number {
    return this.options.now() + this.offsetMs;
  }

  offset(): number {
    return this.offsetMs;
  }

  /** True once the initial burst has produced a usable estimate. Audio must
   * not start before this (§5.1). */
  isReady(): boolean {
    return this.ready;
  }

  getState(): ClockSyncState {
    return {
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      quality: this.quality,
      samples: this.samples.length,
      ready: this.ready,
    };
  }

  /** Starts (or restarts) with a burst, then settles into maintenance. */
  start(): void {
    this.stopped = false;
    this.burst();
  }

  /** Throws the estimate away and measures again from scratch — used after a
   * reconnection and after a clock jump. */
  resync(): void {
    this.samples = [];
    this.ready = false;
    this.burst();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.inFlight.clear();
    this.burstLeft = 0;
  }

  /** Feeds one `time.pong` back in. Unknown or duplicated pongs are ignored:
   * a replayed sample would weight the median twice. */
  onPong(pong: PongInput): void {
    if (!this.inFlight.delete(pong.clientSendMs)) return;

    const t3 = this.options.now();
    const t0 = pong.clientSendMs;
    const rttMs = t3 - t0 - (pong.serverSendMs - pong.serverRecvMs);
    const offsetMs =
      (pong.serverRecvMs - t0 + (pong.serverSendMs - t3)) / 2;

    // A negative round trip means the two clocks moved under us mid-sample.
    if (!Number.isFinite(rttMs) || !Number.isFinite(offsetMs) || rttMs < 0) return;

    if (this.ready && this.hasJumped(offsetMs, rttMs)) {
      // Not drift: the clock moved. Following that with an EMA would leave the
      // client audibly late for a minute, so jump and measure again from
      // scratch (§5.1).
      this.offsetMs = offsetMs;
      this.rttMs = rttMs;
      this.publish();
      this.resync();
      return;
    }

    this.samples.push({ rttMs, offsetMs, atMs: t3 });
    if (this.samples.length > WINDOW) this.samples.shift();
    this.prune(t3);

    this.recompute();
  }

  /**
   * A single sample cannot be trusted to move the estimate — that is what the
   * median is for — but it *can* prove the clock moved. Network asymmetry can
   * only bias an offset by half the round trip, so a deviation larger than the
   * whole round trip (and larger than the absolute threshold) is not something
   * jitter can produce.
   */
  private hasJumped(offsetMs: number, rttMs: number): boolean {
    const deviation = Math.abs(offsetMs - this.offsetMs);
    return deviation > JUMP_THRESHOLD_MS && deviation > rttMs;
  }

  private prune(nowMs: number): void {
    if (this.samples.length <= MIN_SAMPLES) return;
    const fresh = this.samples.filter((s) => nowMs - s.atMs <= MAX_SAMPLE_AGE_MS);
    this.samples =
      fresh.length >= MIN_SAMPLES ? fresh : this.samples.slice(-MIN_SAMPLES);
  }

  private burst(): void {
    this.clearTimer();
    this.burstLeft = BURST_COUNT;
    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;

    // Whole milliseconds: `clientSendMs` is an int64 on the wire, and the
    // server rejects the whole message rather than truncating a float — so an
    // unrounded `performance.now()` means every sample is refused and the
    // clock never syncs at all. Rounding here (rather than at the codec) keeps
    // the value the pong is matched against identical to the one that was
    // sent; the sub-millisecond loss is far inside the ±15 ms budget.
    const t0 = Math.round(this.options.now());
    this.inFlight.add(t0);
    // An unanswered ping must not pin a sample slot forever.
    if (this.inFlight.size > WINDOW * 2) {
      const oldest = this.inFlight.values().next().value;
      if (oldest !== undefined) this.inFlight.delete(oldest);
    }
    this.options.sendPing(t0);

    const bursting = this.burstLeft > 0;
    if (bursting) this.burstLeft -= 1;
    this.schedule(bursting && this.burstLeft > 0 ? BURST_INTERVAL_MS : MAINTENANCE_INTERVAL_MS);
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private recompute(): void {
    const candidate = this.estimate();
    if (candidate === null) return;

    if (!this.ready) {
      this.offsetMs = candidate.offsetMs;
      this.ready = true;
    } else {
      const delta = candidate.offsetMs - this.offsetMs;
      this.offsetMs += delta * EMA_ALPHA;
      if (Math.abs(delta) > DRIFT_ALARM_MS && this.burstLeft === 0) {
        // Outside the §5.4 budget: take another look now rather than in 5 s.
        this.schedule(DRIFT_RECHECK_MS);
      }
    }
    this.rttMs = candidate.rttMs;
    this.publish();
  }

  /**
   * §5.1 filtering: reject the round trips more than twice the best one, sort
   * what remains by rtt, keep the lower quartile (the 3 fastest) and take the
   * median of their offsets.
   */
  private estimate(): { offsetMs: number; rttMs: number } | null {
    if (this.samples.length === 0) return null;

    const rttMin = Math.min(...this.samples.map((s) => s.rttMs));
    const usable = this.samples
      .filter((s) => s.rttMs <= rttMin * RTT_REJECT_FACTOR)
      // Equal round trips are the common case on a good link; breaking the tie
      // by recency keeps the estimate following the network rather than the
      // first samples it ever saw.
      .sort((a, b) => a.rttMs - b.rttMs || b.atMs - a.atMs)
      .slice(0, BEST_SAMPLES);
    if (usable.length === 0) return null;

    const offsets = usable.map((s) => s.offsetMs).sort((a, b) => a - b);
    const offsetMs = median(offsets);
    this.quality = gradeQuality(rttMin, spread(offsets));
    return { offsetMs, rttMs: rttMin };
  }

  private publish(): void {
    this.options.onUpdate?.(this.getState());
  }
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function spread(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Three levels, shown in the UI (§5.1): the musician needs to know whether
 * their phone is in time, and "degraded" is actionable — move nearer the
 * router, or accept a looser feel. */
export function gradeQuality(rttMinMs: number, spreadMs: number): SyncQuality {
  if (rttMinMs <= GOOD_RTT_MS && spreadMs <= GOOD_SPREAD_MS) return "good";
  if (rttMinMs <= FAIR_RTT_MS && spreadMs <= FAIR_SPREAD_MS) return "fair";
  return "poor";
}

export const SYNC_QUALITY_LABEL: Record<SyncQuality, string> = {
  unknown: "SYNC …",
  good: "SYNC OK",
  fair: "SYNC MOYENNE",
  poor: "SYNC DÉGRADÉE",
};
