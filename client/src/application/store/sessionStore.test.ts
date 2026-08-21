import { beforeEach, describe, expect, it } from "vitest";

import { parameterSlot } from "@/domain/parameter";
import { transportAt } from "@/domain/transport";
import type { Transport } from "@/domain/types";
import type { ServerMessage } from "@/infrastructure/ws/codec";

import { useSessionStore } from "./sessionStore";

function transport(bpm: number, generation: number): Transport {
  return {
    state: "playing",
    anchor: { atServerMs: 0, atBeat: 0, bpm },
    beatsPerBar: 4,
    stepsPerBeat: 4,
    generation,
  };
}

function snapshot(generation: number): ServerMessage {
  return {
    type: "state.snapshot",
    data: {
      transport: transport(120, generation),
      params: [{ key: "cutoff", value: 0.5, target: { group: 0 } }],
      patterns: [{ trackId: "kick", steps: [{ on: true, velocity: 1, note: 36 }], generation }],
      groups: [{ id: 1, label: "HIGH", count: 2 }],
      generation,
      serverTimeMs: 1000,
    },
  };
}

const apply = (message: ServerMessage) => useSessionStore.getState().apply(message);

beforeEach(() => {
  useSessionStore.getState().reset();
});

describe("§4.4 idempotence", () => {
  it("ignores a state message that is not newer", () => {
    apply(snapshot(10));

    apply({
      type: "param.updated",
      data: {
        entry: { key: "cutoff", value: 0.9, target: { group: 0 } },
        generation: 9,
      },
    });

    const state = useSessionStore.getState();
    expect(state.generation).toBe(10);
    expect(state.params.get(parameterSlot("cutoff", { group: 0 }))!.value).toBe(0.5);
  });

  it("applies a strictly newer message", () => {
    apply(snapshot(10));
    apply({
      type: "param.updated",
      data: {
        entry: { key: "cutoff", value: 0.9, target: { group: 2 } },
        generation: 11,
      },
    });

    const state = useSessionStore.getState();
    expect(state.generation).toBe(11);
    expect(state.params.get(parameterSlot("cutoff", { group: 2 }))!.value).toBe(0.9);
    // The session-scoped value is untouched: scopes are stored side by side.
    expect(state.params.get(parameterSlot("cutoff", { group: 0 }))!.value).toBe(0.5);
  });

  it("replaces the whole state on a snapshot rather than merging", () => {
    apply(snapshot(10));
    apply({
      type: "pattern.updated",
      data: {
        pattern: { trackId: "hat", steps: [{ on: true, velocity: 1, note: 36 }], generation: 11 },
        generation: 11,
      },
    });
    expect(useSessionStore.getState().patterns.size).toBe(2);

    // A reconnection snapshot that no longer mentions the hat must not leave
    // it behind: after a resync the server's state is the only state.
    apply(snapshot(20));
    const state = useSessionStore.getState();
    expect([...state.patterns.keys()]).toEqual(["kick"]);
    expect(state.generation).toBe(20);
  });
});

describe("transport changes (§5.4)", () => {
  it("queues an announced change instead of applying it now", () => {
    apply(snapshot(10));
    apply({
      type: "transport.updated",
      data: {
        transport: transport(90, 11),
        effectiveAtServerMs: 4000,
        generation: 11,
      },
    });

    const { timeline } = useSessionStore.getState();
    expect(transportAt(timeline, 3999).anchor.bpm).toBe(120);
    expect(transportAt(timeline, 4000).anchor.bpm).toBe(90);
  });

  it("does not promote a queued change when a second one arrives", () => {
    apply(snapshot(10));
    apply({
      type: "transport.updated",
      data: { transport: transport(90, 11), effectiveAtServerMs: 4000, generation: 11 },
    });
    apply({
      type: "transport.updated",
      data: { transport: transport(150, 12), effectiveAtServerMs: 6000, generation: 12 },
    });

    const { timeline } = useSessionStore.getState();
    expect(transportAt(timeline, 1000).anchor.bpm).toBe(120);
    expect(transportAt(timeline, 5000).anchor.bpm).toBe(90);
    expect(transportAt(timeline, 7000).anchor.bpm).toBe(150);
  });

  it("folds a change in only once its boundary is behind us", () => {
    apply(snapshot(10));
    apply({
      type: "transport.updated",
      data: { transport: transport(90, 11), effectiveAtServerMs: 4000, generation: 11 },
    });

    useSessionStore.getState().settleTimeline(3999);
    expect(useSessionStore.getState().timeline.pending).toHaveLength(1);

    useSessionStore.getState().settleTimeline(4000);
    const { timeline } = useSessionStore.getState();
    expect(timeline.pending).toHaveLength(0);
    expect(timeline.active.anchor.bpm).toBe(90);
  });
});

describe("presence", () => {
  it("keeps the authoritative counts and logs the arrivals it sees", () => {
    apply({
      type: "participant.joined",
      data: {
        participantId: "p1",
        name: "Zoé",
        role: "musician",
        groupId: 1,
        counts: [{ id: 1, label: "HIGH", count: 1 }],
      },
    });
    expect(useSessionStore.getState().roster.map((entry) => entry.id)).toEqual(["p1"]);
    expect(useSessionStore.getState().groups[0]!.count).toBe(1);

    apply({
      type: "participant.left",
      data: {
        participantId: "p1",
        name: "Zoé",
        role: "musician",
        groupId: 1,
        counts: [{ id: 1, label: "HIGH", count: 0 }],
      },
    });
    expect(useSessionStore.getState().roster).toHaveLength(0);
    expect(useSessionStore.getState().groups[0]!.count).toBe(0);
  });
});
