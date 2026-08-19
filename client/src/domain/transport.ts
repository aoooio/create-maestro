/**
 * Port of `server/internal/domain/session/transport.go`, plus the one thing the
 * server never needs: resolving a window of server time into the steps that
 * must sound inside it (§5.3).
 */

import { beatsToMs, msToBeats, positionAt } from "./musicalTime";
import type { PlayState, Position, StepEvent, TempoAnchor, Transport } from "./types";

/** Bounds enforced by the Go domain. The UI clamps to the same values so that
 * it never sends something the server will reject. */
export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MIN_BEATS_PER_BAR = 1;
export const MAX_BEATS_PER_BAR = 16;
export const MIN_STEPS_PER_BEAT = 1;
export const MAX_STEPS_PER_BEAT = 8;

/** Floor applied to every scheduled change (§5.4): nothing is ever published
 * less than this far in the future. */
export const MIN_LEAD_MS = 300;

/** Absorbs float noise so a boundary landing exactly on the cursor is not
 * pushed a whole bar (or a whole step) away. */
const EPSILON = 1e-9;

/** Guards the scheduler against a pathological window (a huge lookahead, an
 * absurd tempo): a window can never yield more than this many steps. */
const MAX_STEPS_PER_WINDOW = 512;

export function newTransport(nowMs: number, bpm: number): Transport {
  return {
    state: "stopped",
    anchor: { atServerMs: nowMs, atBeat: 0, bpm },
    beatsPerBar: 4,
    stepsPerBeat: 4,
    generation: 0,
  };
}

/**
 * Musical position at an instant of server time. A stopped transport is frozen
 * on its anchor: musical time does not advance.
 */
export function beatAt(t: Transport, serverMs: number): number {
  if (t.state !== "playing") return t.anchor.atBeat;
  return t.anchor.atBeat + msToBeats(serverMs - t.anchor.atServerMs, t.anchor.bpm);
}

/** Inverse of `beatAt`: the instant a beat is reached. */
export function serverMsAtBeat(t: Transport, beat: number): number {
  return (
    t.anchor.atServerMs + Math.round(beatsToMs(beat - t.anchor.atBeat, t.anchor.bpm))
  );
}

export function positionOf(t: Transport, serverMs: number): Position {
  return positionAt(beatAt(t, serverMs), t.beatsPerBar, t.stepsPerBeat);
}

/**
 * First bar boundary at least MIN_LEAD_MS in the future — where structural
 * changes land. On a stopped transport there is no upcoming boundary, so the
 * floor itself is returned. Same rule as the server, so the console can show
 * where a pending change will actually take effect.
 */
export function nextBarBoundary(t: Transport, serverMs: number): number {
  const earliest = serverMs + MIN_LEAD_MS;
  if (t.state !== "playing") return earliest;
  const barBeats = t.beatsPerBar;
  const beat = beatAt(t, earliest);
  const next = Math.ceil(beat / barBeats - EPSILON) * barBeats;
  return Math.max(serverMsAtBeat(t, next), earliest);
}

/**
 * Every step whose instant falls in `[fromMs, toMs)`, in order. This is what
 * the lookahead scheduler consumes: it asks for the next 150 ms and schedules
 * exactly what it gets back.
 */
export function stepsBetween(
  t: Transport,
  fromMs: number,
  toMs: number,
): StepEvent[] {
  if (t.state !== "playing" || toMs <= fromMs) return [];

  const perBeat = t.stepsPerBeat;
  const stepsInBar = t.beatsPerBar * perBeat;
  const beatFrom = beatAt(t, fromMs);
  const beatTo = beatAt(t, toMs);

  const events: StepEvent[] = [];
  let index = Math.ceil(beatFrom * perBeat - EPSILON);
  while (index / perBeat < beatTo - EPSILON && events.length < MAX_STEPS_PER_WINDOW) {
    const beat = index / perBeat;
    // A negative index would fold onto the wrong side of zero with `%`.
    const inBar = ((index % stepsInBar) + stepsInBar) % stepsInBar;
    events.push({
      serverMs: serverMsAtBeat(t, beat),
      index,
      stepInBar: inBar,
      bar: Math.floor(beat / t.beatsPerBar),
      beat,
    });
    index++;
  }
  return events;
}

/** A transport change the server has announced for a future instant. */
export interface ScheduledTransport {
  readonly transport: Transport;
  readonly effectiveAtServerMs: number;
}

/**
 * The transport in force, plus the changes already announced for later (§5.4).
 * Holding both is what lets a client keep the old anchor for everything
 * scheduled before a boundary and switch cleanly beyond it, instead of jumping
 * the phase the instant the message arrives.
 *
 * `pending` is a queue, not a slot: with a 300 ms floor and bar alignment, a
 * maestro turning a dial can easily have two changes in flight, and the second
 * one's anchor was computed from the first.
 */
export interface Timeline {
  readonly active: Transport;
  readonly pending: readonly ScheduledTransport[];
}

export function newTimeline(active: Transport): Timeline {
  return { active, pending: [] };
}

/** Queues an announced change, keeping the queue ordered by effective instant.
 * A change re-announced for an instant already queued replaces it. */
export function schedule(tl: Timeline, change: ScheduledTransport): Timeline {
  const pending = tl.pending.filter(
    (item) => item.effectiveAtServerMs !== change.effectiveAtServerMs,
  );
  pending.push(change);
  pending.sort((a, b) => a.effectiveAtServerMs - b.effectiveAtServerMs);
  return { active: tl.active, pending };
}

/** The transport that governs a given instant. */
export function transportAt(tl: Timeline, serverMs: number): Transport {
  let current = tl.active;
  for (const item of tl.pending) {
    if (serverMs < item.effectiveAtServerMs) break;
    current = item.transport;
  }
  return current;
}

/**
 * Folds every change that is now in the past into `active`. Called by the
 * scheduler on each tick so the timeline does not accumulate history.
 */
export function settle(tl: Timeline, serverMs: number): Timeline {
  const due = tl.pending.filter((item) => serverMs >= item.effectiveAtServerMs);
  if (due.length === 0) return tl;
  return {
    active: due[due.length - 1]!.transport,
    pending: tl.pending.slice(due.length),
  };
}

/**
 * Steps of a window, split at every announced boundary it straddles: each
 * segment is resolved with the anchor that actually governs it. This is the
 * whole of §5.4 in one function.
 */
export function stepsBetweenTimeline(
  tl: Timeline,
  fromMs: number,
  toMs: number,
): StepEvent[] {
  const boundaries = tl.pending
    .map((item) => item.effectiveAtServerMs)
    .filter((at) => at > fromMs && at < toMs);

  const events: StepEvent[] = [];
  let cursor = fromMs;
  for (const boundary of [...boundaries, toMs]) {
    events.push(...stepsBetween(transportAt(tl, cursor), cursor, boundary));
    cursor = boundary;
  }
  return events;
}

export function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

export function isValidTransport(t: Transport): boolean {
  return (
    t.anchor.bpm >= MIN_BPM &&
    t.anchor.bpm <= MAX_BPM &&
    t.beatsPerBar >= MIN_BEATS_PER_BAR &&
    t.beatsPerBar <= MAX_BEATS_PER_BAR &&
    t.stepsPerBeat >= MIN_STEPS_PER_BEAT &&
    t.stepsPerBeat <= MAX_STEPS_PER_BEAT
  );
}

export function anchorOf(t: Transport): TempoAnchor {
  return t.anchor;
}

export function playStateLabel(state: PlayState): string {
  return state === "playing" ? "PLAY" : "STOP";
}
