import { describe, expect, it } from "vitest";

import { DecodeError, ProtocolVersionError, decode, encode } from "./codec";

function frame(type: string, data: unknown, version = 1): string {
  return JSON.stringify({ v: version, t: type, id: "01J", ts: 1, d: data });
}

describe("decode", () => {
  it("maps a snapshot onto domain types", () => {
    const message = decode(
      frame("state.snapshot", {
        transport: {
          anchor: { atServerMs: 1000, atBeat: 4, bpm: 128 },
          state: "playing",
          beatsPerBar: 4,
          stepsPerBeat: 4,
          generation: 7,
        },
        params: [
          { key: "cutoff", value: 0.5, target: "all" },
          { key: "mute", value: true, target: "group:2" },
        ],
        patterns: [{ trackId: "kick", steps: [true, false], velocity: [0.8, 0], generation: 7 }],
        groups: [{ id: 1, label: "HIGH", count: 3 }],
        generation: 7,
        serverTimeMs: 1234,
      }),
    );

    expect(message.type).toBe("state.snapshot");
    if (message.type !== "state.snapshot") return;
    expect(message.data.transport.anchor.bpm).toBe(128);
    expect(message.data.params[1]!.target).toEqual({ group: 2 });
    expect(message.data.params[1]!.value).toBe(true);
    expect(message.data.patterns[0]!.steps).toEqual([
      { on: true, velocity: 0.8 },
      { on: false, velocity: 0 },
    ]);
  });

  it("defaults a missing velocity to full level on an active step", () => {
    const message = decode(
      frame("pattern.updated", { trackId: "hat", steps: [true, false], generation: 3 }),
    );
    if (message.type !== "pattern.updated") throw new Error("wrong type");
    expect(message.data.pattern.steps[0]!.velocity).toBe(1);
    expect(message.data.pattern.steps[1]!.velocity).toBe(0);
  });

  it("carries the effective instant of a transport change", () => {
    const message = decode(
      frame("transport.updated", {
        anchor: { atServerMs: 2000, atBeat: 8, bpm: 90 },
        state: "playing",
        beatsPerBar: 4,
        stepsPerBeat: 4,
        effectiveAtServerMs: 2000,
        generation: 12,
      }),
    );
    if (message.type !== "transport.updated") throw new Error("wrong type");
    expect(message.data.effectiveAtServerMs).toBe(2000);
    expect(message.data.transport.anchor.bpm).toBe(90);
  });

  it("ignores unknown fields, as §4.1 requires", () => {
    const message = decode(
      frame("group.assigned", { groupId: 1, label: "HIGH", reason: "balanced", future: 42 }),
    );
    expect(message.type).toBe("group.assigned");
  });

  it("refuses a protocol version it cannot read", () => {
    expect(() => decode(frame("welcome", {}, 2))).toThrow(ProtocolVersionError);
  });

  it("refuses a frame it cannot map to a known message", () => {
    expect(() => decode(frame("transport.exploded", {}))).toThrow(DecodeError);
    expect(() => decode("{oops")).toThrow(DecodeError);
    expect(() => decode(frame("time.pong", { clientSendMs: "soon" }))).toThrow(DecodeError);
  });
});

describe("encode", () => {
  it("wraps a command in the protocol envelope", () => {
    const { id, frame: raw } = encode(
      { t: "transport.set", d: { bpm: 96, alignTo: "bar" } },
      1700,
    );
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ v: 1, t: "transport.set", id, ts: 1700 });
    expect(parsed.d).toEqual({ bpm: 96, alignTo: "bar" });
  });

  it("gives every message its own id", () => {
    const a = encode({ t: "state.request", d: {} }, 0);
    const b = encode({ t: "state.request", d: {} }, 0);
    expect(a.id).not.toBe(b.id);
  });
});
