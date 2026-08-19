import { describe, expect, it } from "vitest";

import {
  MIN_LEAD_MS,
  beatAt,
  newTimeline,
  nextBarBoundary,
  schedule,
  serverMsAtBeat,
  settle,
  stepsBetween,
  stepsBetweenTimeline,
  transportAt,
  type Timeline,
} from "./transport";
import type { Transport } from "./types";

/** Same fixture as `transport_test.go`, so the two domains can be compared
 * line by line when one of them changes. */
function playing(bpm: number, atMs: number, atBeat: number): Transport {
  return {
    state: "playing",
    anchor: { atServerMs: atMs, atBeat, bpm },
    beatsPerBar: 4,
    stepsPerBeat: 4,
    generation: 0,
  };
}

describe("beatAt", () => {
  const cases: Array<[string, Transport, number, number]> = [
    ["anchor instant", playing(120, 1000, 0), 1000, 0],
    ["one beat at 120bpm", playing(120, 1000, 0), 1500, 1],
    ["one bar at 120bpm", playing(120, 1000, 0), 3000, 4],
    ["before the anchor", playing(120, 1000, 8), 500, 7],
    ["60bpm is one beat per second", playing(60, 0, 0), 3000, 3],
    ["140bpm", playing(140, 0, 0), 60000, 140],
    [
      "a stopped transport is frozen",
      { ...playing(120, 0, 7.5), state: "stopped" },
      999999,
      7.5,
    ],
  ];

  it.each(cases)("%s", (_name, transport, atMs, want) => {
    expect(beatAt(transport, atMs)).toBeCloseTo(want, 9);
  });
});

describe("serverMsAtBeat", () => {
  it("round-trips with beatAt at every tempo", () => {
    for (const bpm of [20, 60, 90, 120, 128, 174, 300]) {
      const transport = playing(bpm, 1_700_000_000_000, 12.25);
      for (const offset of [0, 1, 250, 1000, 60_000, 3_600_000]) {
        const at = transport.anchor.atServerMs + offset;
        expect(serverMsAtBeat(transport, beatAt(transport, at))).toBe(at);
      }
    }
  });
});

describe("nextBarBoundary", () => {
  it("skips a boundary that is closer than the lead floor", () => {
    // At 120 BPM a bar lasts 2000 ms; now=1900 sits 100 ms before the bar at
    // 2000 ms, so the change has to wait for the following one.
    expect(nextBarBoundary(playing(120, 0, 0), 1900)).toBe(4000);
  });

  it("takes the next bar when there is room", () => {
    expect(nextBarBoundary(playing(120, 0, 0), 1000)).toBe(2000);
  });

  it("keeps a boundary landing exactly on the floor", () => {
    expect(nextBarBoundary(playing(120, 0, 0), 2000 - MIN_LEAD_MS)).toBe(2000);
  });

  it("always lands on a bar, whatever the tempo and the anchor", () => {
    const transport = playing(137, 4321, 3.7);
    const at = nextBarBoundary(transport, 10_000);
    const bars = beatAt(transport, at) / transport.beatsPerBar;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-3);
    expect(at).toBeGreaterThanOrEqual(10_000 + MIN_LEAD_MS);
  });

  it("falls back to the lead floor on a stopped transport", () => {
    const stopped: Transport = { ...playing(120, 0, 0), state: "stopped" };
    expect(nextBarBoundary(stopped, 5000)).toBe(5000 + MIN_LEAD_MS);
  });
});

describe("stepsBetween", () => {
  it("returns the steps of the window, half-open on the right", () => {
    // 120 BPM, 4 steps per beat: one step every 125 ms.
    const events = stepsBetween(playing(120, 0, 0), 0, 500);
    expect(events.map((e) => e.serverMs)).toEqual([0, 125, 250, 375]);
    expect(events.map((e) => e.stepInBar)).toEqual([0, 1, 2, 3]);
  });

  it("never yields the same step twice across adjacent windows", () => {
    const transport = playing(174, 12_345, 8.5);
    const seen = new Set<number>();
    for (let from = 12_345; from < 12_345 + 4000; from += 150) {
      for (const event of stepsBetween(transport, from, from + 150)) {
        expect(seen.has(event.index)).toBe(false);
        seen.add(event.index);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("wraps step positions onto the bar", () => {
    const events = stepsBetween(playing(120, 0, 0), 0, 2500);
    expect(events).toHaveLength(20);
    expect(events[15]!.stepInBar).toBe(15);
    expect(events[16]!.stepInBar).toBe(0);
    expect(events[16]!.bar).toBe(1);
  });

  it("yields nothing while stopped", () => {
    const stopped: Transport = { ...playing(120, 0, 0), state: "stopped" };
    expect(stepsBetween(stopped, 0, 10_000)).toEqual([]);
  });

  it("yields nothing for an empty or inverted window", () => {
    expect(stepsBetween(playing(120, 0, 0), 500, 500)).toEqual([]);
    expect(stepsBetween(playing(120, 0, 0), 500, 100)).toEqual([]);
  });
});

describe("timeline (§5.4)", () => {
  // A tempo change announced by the server: the beat at the boundary is
  // computed with the *old* tempo, which is what keeps the phase continuous.
  const active = playing(120, 0, 0);
  const slower = playing(90, 2000, beatAt(active, 2000));
  const timeline: Timeline = schedule(newTimeline(active), {
    transport: slower,
    effectiveAtServerMs: 2000,
  });

  it("keeps the old transport before the boundary and the new one after", () => {
    expect(transportAt(timeline, 1999).anchor.bpm).toBe(120);
    expect(transportAt(timeline, 2000).anchor.bpm).toBe(90);
  });

  it("does not jump the phase at the boundary", () => {
    expect(beatAt(active, 2000)).toBeCloseTo(beatAt(slower, 2000), 9);
  });

  it("splits a window straddling the boundary", () => {
    const events = stepsBetweenTimeline(timeline, 1900, 2200);
    // Before: 125 ms steps, so 1875 is out and 2000 is the boundary itself.
    // After: 90 BPM, 4 steps per beat, one step every 166.67 ms.
    expect(events.map((e) => e.serverMs)).toEqual([2000, 2167]);
    expect(events.every((e, i) => i === 0 || e.serverMs > events[i - 1]!.serverMs)).toBe(
      true,
    );
  });

  it("folds a change in once it is in the past", () => {
    expect(settle(timeline, 1999).pending).toHaveLength(1);
    expect(settle(timeline, 2000).pending).toHaveLength(0);
    expect(settle(timeline, 2000).active.anchor.bpm).toBe(90);
  });

  it("holds two changes in flight without promoting the second early", () => {
    // A maestro turning a dial: the 300 ms floor plus bar alignment easily
    // puts a second change on the wire before the first has landed.
    const faster = playing(150, 4000, beatAt(slower, 4000));
    const queued = schedule(timeline, {
      transport: faster,
      effectiveAtServerMs: 4000,
    });

    expect(transportAt(queued, 1000).anchor.bpm).toBe(120);
    expect(transportAt(queued, 3000).anchor.bpm).toBe(90);
    expect(transportAt(queued, 5000).anchor.bpm).toBe(150);

    // Crossing only the first boundary must leave the second one queued.
    const settled = settle(queued, 2500);
    expect(settled.active.anchor.bpm).toBe(90);
    expect(settled.pending).toHaveLength(1);
  });

  it("splits a window straddling two boundaries", () => {
    const faster = playing(150, 2200, beatAt(slower, 2200));
    const queued = schedule(timeline, {
      transport: faster,
      effectiveAtServerMs: 2200,
    });
    const events = stepsBetweenTimeline(queued, 1900, 2400);
    expect(events.every((e, i) => i === 0 || e.serverMs > events[i - 1]!.serverMs)).toBe(
      true,
    );
    // Nothing from the 120 BPM segment (its last step was at 1875), then two
    // steps 167 ms apart under the 90 BPM anchor, then the 150 BPM grid takes
    // over at 100 ms per step — off the beat the tempo change left it on.
    expect(events.map((e) => e.serverMs)).toEqual([2000, 2167, 2280, 2380]);
  });
});
