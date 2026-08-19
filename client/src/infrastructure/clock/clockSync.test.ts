import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClockSync, gradeQuality, type ClockSyncState } from "./clockSync";

/**
 * A simulated network, so the filtering can be tested against jitter, loss and
 * a clock jump without a server and without waiting in real time. The client
 * clock and the fake timers are advanced in lockstep.
 */
class Network {
  clientNow = 1000;
  /** The truth the estimator is supposed to find. */
  trueOffset = 500_000;
  pending: number[] = [];
  updates: ClockSyncState[] = [];
  readonly sync: ClockSync;

  constructor() {
    this.sync = new ClockSync({
      now: () => this.clientNow,
      sendPing: (t0) => this.pending.push(t0),
      onUpdate: (state) => this.updates.push(state),
    });
  }

  advance(ms: number): void {
    this.clientNow += ms;
    vi.advanceTimersByTime(ms);
  }

  /** Answers the oldest outstanding ping with a given uplink/downlink split. */
  answer({ up = 10, down = 10, serverWork = 1 }: { up?: number; down?: number; serverWork?: number } = {}): void {
    const t0 = this.pending.shift();
    if (t0 === undefined) throw new Error("no ping in flight");

    this.advance(up);
    const serverRecvMs = this.clientNow + this.trueOffset;
    this.advance(serverWork);
    const serverSendMs = this.clientNow + this.trueOffset;
    this.advance(down);
    this.sync.onPong({ clientSendMs: t0, serverRecvMs, serverSendMs });
  }

  /** Drops the oldest ping on the floor, as a lost packet would. */
  drop(): void {
    this.pending.shift();
  }

  /** Runs a full clean burst. */
  burst(options?: { up?: number; down?: number }): void {
    for (let i = 0; i < 12; i++) {
      this.answer(options);
      this.advance(120);
    }
  }
}

let net: Network;

beforeEach(() => {
  vi.useFakeTimers();
  net = new Network();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("offset estimation", () => {
  it("recovers the true offset on a symmetric link", () => {
    net.sync.start();
    net.burst({ up: 10, down: 10 });

    expect(net.sync.isReady()).toBe(true);
    expect(net.sync.offset()).toBeCloseTo(net.trueOffset, 6);
    expect(net.sync.serverNowMs()).toBeCloseTo(net.clientNow + net.trueOffset, 6);
  });

  it("is only ready once the burst has produced an estimate", () => {
    net.sync.start();
    expect(net.sync.isReady()).toBe(false);

    net.answer();
    expect(net.sync.isReady()).toBe(true);
  });

  it("splits an asymmetric link down the middle, as NTP does", () => {
    net.sync.start();
    // 40 ms out, 10 ms back: the estimate is off by half the asymmetry, and
    // no amount of sampling can do better — this is the known limit of the
    // method, not a bug to chase.
    net.burst({ up: 40, down: 10 });
    expect(net.sync.offset() - net.trueOffset).toBeCloseTo(15, 0);
  });

  it("rejects the samples that arrived late", () => {
    net.sync.start();
    // Ten clean round trips, then two badly delayed ones: the outliers must
    // not move the estimate.
    for (let i = 0; i < 10; i++) {
      net.answer({ up: 10, down: 10 });
      net.advance(120);
    }
    const clean = net.sync.offset();

    for (let i = 0; i < 2; i++) {
      net.answer({ up: 300, down: 20 });
      net.advance(120);
    }
    expect(net.sync.offset()).toBeCloseTo(clean, 6);
  });

  it("survives a lost pong", () => {
    net.sync.start();
    net.answer();
    net.advance(120);
    net.drop();
    net.advance(120);
    net.answer();

    expect(net.sync.isReady()).toBe(true);
    expect(net.sync.offset()).toBeCloseTo(net.trueOffset, 6);
  });

  it("ignores a pong nobody asked for", () => {
    net.sync.start();
    net.burst();
    const before = net.sync.offset();

    net.sync.onPong({ clientSendMs: -1, serverRecvMs: 0, serverSendMs: 0 });
    expect(net.sync.offset()).toBe(before);
  });
});

describe("maintenance", () => {
  it("absorbs a slow drift gradually, never in one step", () => {
    net.sync.start();
    net.burst();

    // 20 ms of drift: inside the budget, so it must be followed — but no
    // single sample is allowed to move the estimate by the whole amount.
    net.trueOffset += 20;
    const steps: number[] = [net.sync.offset()];
    for (let i = 0; i < 12; i++) {
      net.advance(5000);
      net.answer();
      steps.push(net.sync.offset());
    }

    const biggestStep = Math.max(
      ...steps.slice(1).map((value, i) => Math.abs(value - steps[i]!)),
    );
    expect(biggestStep).toBeLessThan(20 * 0.15 + 0.1);
    expect(Math.abs(net.sync.offset() - net.trueOffset)).toBeLessThan(5);
  });

  it("does not let one late sample move the estimate", () => {
    net.sync.start();
    net.burst();
    const before = net.sync.offset();

    // One round trip stuck behind a retransmission. The median of the fastest
    // samples is exactly what protects us here.
    net.advance(5000);
    net.answer({ up: 200, down: 20 });
    expect(net.sync.offset()).toBeCloseTo(before, 6);
  });

  it("jumps and resyncs when the clock moves rather than drifts", () => {
    net.sync.start();
    net.burst();

    // A network change or a wake from sleep: 400 ms in one step. Following
    // that with an EMA would leave the client audibly late for a minute.
    net.trueOffset += 400;
    net.advance(5000);
    net.answer();

    expect(net.sync.offset()).toBeCloseTo(net.trueOffset, 0);
    // And the estimate is rebuilt from scratch rather than kept.
    expect(net.sync.isReady()).toBe(false);
  });

  it("keeps pinging on the maintenance interval", () => {
    net.sync.start();
    net.burst();
    net.pending = [];

    net.advance(5000);
    expect(net.pending).toHaveLength(1);
  });

  it("stops sending once stopped", () => {
    net.sync.start();
    net.burst();
    net.sync.stop();
    net.pending = [];

    net.advance(60_000);
    expect(net.pending).toHaveLength(0);
  });
});

describe("quality grading", () => {
  it("reads a fast, steady link as good", () => {
    expect(gradeQuality(20, 3)).toBe("good");
  });

  it("degrades on latency or on spread, whichever is worse", () => {
    expect(gradeQuality(120, 3)).toBe("fair");
    expect(gradeQuality(20, 25)).toBe("fair");
    expect(gradeQuality(400, 3)).toBe("poor");
    expect(gradeQuality(20, 90)).toBe("poor");
  });

  it("is reported to the host as samples come in", () => {
    net.sync.start();
    net.burst();
    expect(net.updates.at(-1)!.quality).toBe("good");
    expect(net.updates.at(-1)!.ready).toBe(true);
  });
});
