import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioClock, type AudioContextLike } from "./audioClock";

/** A context whose two clocks can be moved independently — which is the whole
 * problem this class exists to solve. */
class FakeContext implements AudioContextLike {
  currentTime = 10;
  baseLatency = 0.005;
  outputLatency = 0.015;
  timestamp: { contextTime?: number; performanceTime?: number } | undefined;

  getOutputTimestamp(): { contextTime?: number; performanceTime?: number } {
    return this.timestamp ?? {};
  }
}

let context: FakeContext;
let perfNow: number;
let offsetMs: number;
let clock: AudioClock;

beforeEach(() => {
  vi.useFakeTimers();
  context = new FakeContext();
  perfNow = 5000;
  offsetMs = 1_700_000_000_000;
  clock = new AudioClock({
    context,
    offsetMs: () => offsetMs,
    now: () => perfNow,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("server time → audio time", () => {
  it("maps the anchor instant onto the anchor itself", () => {
    clock.refresh();
    expect(clock.serverMsToAudioTime(perfNow + offsetMs)).toBeCloseTo(10, 9);
  });

  it("advances one second of server time as one second of audio time", () => {
    clock.refresh();
    expect(clock.serverMsToAudioTime(perfNow + offsetMs + 1000)).toBeCloseTo(11, 9);
  });

  it("prefers a matched timestamp pair over reading the two clocks in turn", () => {
    // `getOutputTimestamp` reports a context time 0.5 s behind `currentTime`;
    // reading the clocks separately would bake that gap into every schedule.
    context.timestamp = { contextTime: 9.5, performanceTime: 5000 };
    clock.refresh();
    expect(clock.serverMsToAudioTime(perfNow + offsetMs)).toBeCloseTo(9.5, 9);
  });

  it("ignores a timestamp the engine has not filled in yet", () => {
    context.timestamp = { contextTime: 0, performanceTime: 0 };
    clock.refresh();
    expect(clock.serverMsToAudioTime(perfNow + offsetMs)).toBeCloseTo(10, 9);
  });

  it("follows the offset as the clock sync refines it", () => {
    clock.refresh();
    const serverMs = perfNow + offsetMs;
    const before = clock.serverMsToAudioTime(serverMs);

    // The estimate moves: the client was 30 ms behind the server, so a fixed
    // instant of server time now lands 30 ms earlier on the local clock.
    offsetMs += 30;
    expect(clock.serverMsToAudioTime(serverMs)).toBeCloseTo(before - 0.03, 9);
  });
});

describe("output latency compensation", () => {
  it("starts a source early by the whole output path", () => {
    clock.refresh();
    const serverMs = perfNow + offsetMs + 1000;
    expect(clock.startTimeFor(serverMs)).toBeCloseTo(
      clock.serverMsToAudioTime(serverMs) - 0.02,
      9,
    );
  });

  it("falls back to a plausible latency when the browser will not say", () => {
    const bare = new AudioClock({
      context: { currentTime: 0 },
      offsetMs: () => 0,
      now: () => 0,
    });
    expect(bare.outputLatencySec()).toBeCloseTo(0.02, 9);
  });
});

describe("anchor maintenance", () => {
  it("re-takes the anchor while running", () => {
    clock.start();

    // The audio clock stalls (an interruption) while the system clock runs on.
    perfNow += 2000;
    vi.advanceTimersByTime(2000);
    context.currentTime = 10.5;
    vi.advanceTimersByTime(2000);
    perfNow += 2000;

    // Without a refresh the mapping would still believe the two clocks are in
    // step; with one, the current instant maps to the current context time.
    clock.refresh();
    expect(clock.serverMsToAudioTime(perfNow + offsetMs)).toBeCloseTo(10.5, 9);

    clock.stop();
  });

  it("stops refreshing once stopped", () => {
    clock.start();
    clock.stop();
    const before = clock.serverMsToAudioTime(perfNow + offsetMs);

    context.currentTime = 99;
    vi.advanceTimersByTime(10_000);
    expect(clock.serverMsToAudioTime(perfNow + offsetMs)).toBeCloseTo(before, 9);
  });
});
