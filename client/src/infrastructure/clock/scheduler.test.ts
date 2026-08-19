import { describe, expect, it, vi } from "vitest";

import { newTimeline, schedule } from "@/domain/transport";
import type { StepEvent, Transport } from "@/domain/types";

import { LookaheadScheduler, TimerTickSource, type ScheduleSink, type TickSource } from "./scheduler";

function playing(bpm: number, atMs: number, atBeat: number): Transport {
  return {
    state: "playing",
    anchor: { atServerMs: atMs, atBeat, bpm },
    beatsPerBar: 4,
    stepsPerBeat: 4,
    generation: 0,
  };
}

/** A tick source we pull by hand, so a "tick" is a call and not a wait. */
class ManualTicks implements TickSource {
  private handler: (() => void) | null = null;
  start(onTick: () => void): void {
    this.handler = onTick;
  }
  stop(): void {
    this.handler = null;
  }
  fire(): void {
    this.handler?.();
  }
  get running(): boolean {
    return this.handler !== null;
  }
}

class RecordingSink implements ScheduleSink {
  scheduled: Array<{ event: StepEvent; audioTime: number }> = [];
  cancelled: number[] = [];

  schedule(event: StepEvent, audioTime: number): void {
    this.scheduled.push({ event, audioTime });
  }

  cancelFrom(serverMs: number): void {
    this.cancelled.push(serverMs);
    this.scheduled = this.scheduled.filter((item) => item.event.serverMs < serverMs);
  }

  instants(): number[] {
    return this.scheduled.map((item) => item.event.serverMs);
  }
}

function build(initial = playing(120, 0, 0)) {
  const sink = new RecordingSink();
  const ticks = new ManualTicks();
  let now = 0;
  let timeline = newTimeline(initial);

  const scheduler = new LookaheadScheduler({
    serverNow: () => now,
    timeline: () => timeline,
    onSettled: (settled) => {
      timeline = settled;
    },
    // Audio time is server time in seconds here: it keeps the assertions about
    // *which* instants got scheduled readable, and the mapping itself is
    // AudioClock's job, tested separately.
    toAudioTime: (serverMs) => serverMs / 1000,
    sink,
    tick: ticks,
  });

  return {
    sink,
    ticks,
    scheduler,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
    setTimeline: (next: typeof timeline) => {
      timeline = next;
    },
    getTimeline: () => timeline,
  };
}

describe("lookahead window", () => {
  it("schedules exactly the steps of the next 150 ms", () => {
    const env = build();
    env.scheduler.start();
    env.ticks.fire();

    // 120 BPM, 4 steps per beat: a step every 125 ms.
    expect(env.sink.instants()).toEqual([0, 125]);
  });

  it("never schedules the same step twice", () => {
    const env = build();
    env.scheduler.start();
    for (let i = 0; i < 200; i++) {
      env.ticks.fire();
      env.advance(25);
    }

    const instants = env.sink.instants();
    expect(new Set(instants).size).toBe(instants.length);
    expect(instants).toEqual([...instants].sort((a, b) => a - b));
  });

  it("keeps up with the transport without gaps", () => {
    const env = build();
    env.scheduler.start();
    for (let i = 0; i < 200; i++) {
      env.ticks.fire();
      env.advance(25);
    }

    // 5 s of a 125 ms grid: every step is there, in order.
    const instants = env.sink.instants();
    expect(instants[0]).toBe(0);
    for (let i = 1; i < instants.length; i++) {
      expect(instants[i]! - instants[i - 1]!).toBe(125);
    }
  });

  it("converts each step to an audio time", () => {
    const env = build();
    env.scheduler.start();
    env.ticks.fire();
    expect(env.sink.scheduled[1]!.audioTime).toBeCloseTo(0.125, 9);
  });

  it("does not try to catch up on the past after a pause", () => {
    const env = build();
    env.scheduler.start();
    env.ticks.fire();

    // The tab was frozen for ten seconds; the steps that were missed are gone,
    // not owed.
    env.advance(10_000);
    env.ticks.fire();
    expect(env.sink.instants().filter((ms) => ms > 125 && ms < 10_000)).toEqual([]);
  });

  it("schedules nothing while the transport is stopped", () => {
    const env = build({ ...playing(120, 0, 0), state: "stopped" });
    env.scheduler.start();
    for (let i = 0; i < 20; i++) {
      env.ticks.fire();
      env.advance(25);
    }
    expect(env.sink.scheduled).toEqual([]);
  });
});

describe("tempo change (§5.4)", () => {
  it("cancels and replans what was scheduled beyond the boundary", () => {
    const env = build();
    env.scheduler.start();

    // Plan a while at 120 BPM.
    for (let i = 0; i < 20; i++) {
      env.ticks.fire();
      env.advance(25);
    }
    const before = env.sink.instants();
    expect(before).toContain(500);

    // The server announces 90 BPM from the bar at 1000 ms. Steps already sent
    // to the graph beyond that instant were planned on the wrong anchor.
    const active = env.getTimeline().active;
    env.setTimeline(
      schedule(env.getTimeline(), {
        transport: playing(90, 1000, 2),
        effectiveAtServerMs: 1000,
      }),
    );
    expect(active.anchor.bpm).toBe(120);
    env.scheduler.replanFrom(1000);

    for (let i = 0; i < 40; i++) {
      env.ticks.fire();
      env.advance(25);
    }

    expect(env.sink.cancelled).toEqual([1000]);
    const after = env.sink.instants().filter((ms) => ms >= 1000);
    // At 90 BPM a step lasts 166.67 ms, so the grid past the boundary is the
    // new one — not the 125 ms grid that had already been planned.
    expect(after[0]).toBe(1000);
    expect(after[1]! - after[0]!).toBe(167);
  });

  it("folds a settled change back into the timeline", () => {
    const env = build();
    env.scheduler.start();
    env.setTimeline(
      schedule(env.getTimeline(), {
        transport: playing(90, 1000, 2),
        effectiveAtServerMs: 1000,
      }),
    );

    env.advance(1500);
    env.ticks.fire();

    expect(env.getTimeline().pending).toHaveLength(0);
    expect(env.getTimeline().active.anchor.bpm).toBe(90);
  });
});

describe("lifecycle", () => {
  it("starts and stops its tick source", () => {
    const env = build();
    env.scheduler.start();
    expect(env.ticks.running).toBe(true);

    env.scheduler.stop();
    expect(env.ticks.running).toBe(false);
  });

  it("drives ticks from a plain timer as a fallback", () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const source = new TimerTickSource(25);
    source.start(onTick);

    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(4);

    source.stop();
    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
