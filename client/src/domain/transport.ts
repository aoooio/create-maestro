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

/**
 * A transport and the change already announced for later (§5.4). Keeping both
 * is what lets a client hold the old anchor for everything scheduled before
 * `effectiveAtServerMs` and switch cleanly beyond it, instead of jumping the
 * phase the instant the message arrives.
 */
export interface Timeline {
  readonly active: Transport;
  readonly pending?: {
    readonly transport: Transport;
    readonly effectiveAtServerMs: number;
  };
}

/** The transport that governs a given instant. */
export function transportAt(tl: Timeline, serverMs: number): Transport {
  if (tl.pending && serverMs >= tl.pending.effectiveAtServerMs) {
    return tl.pending.transport;
  }
  return tl.active;
}

/**
 * Folds a pending change in once it is in the past. Called by the scheduler on
 * every tick so the timeline does not accumulate history.
 */
export function settle(tl: Timeline, serverMs: number): Timeline {
  if (tl.pending && serverMs >= tl.pending.effectiveAtServerMs) {
    return { active: tl.pending.transport };
  }
  return tl;
}

/**
 * Steps of a window, split at the pending change: the part before the boundary
 * is resolved with the old anchor, the part after with the new one. This is the
 * whole of §5.4 in one function.
 */
export function stepsBetweenTimeline(
  tl: Timeline,
  fromMs: number,
  toMs: number,
): StepEvent[] {
  const boundary = tl.pending?.effectiveAtServerMs;
  if (boundary === undefined || boundary <= fromMs || boundary >= toMs) {
    return stepsBetween(transportAt(tl, fromMs), fromMs, toMs);
  }
  return [
    ...stepsBetween(tl.active, fromMs, boundary),
    ...stepsBetween(tl.pending!.transport, boundary, toMs),
  ];
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
