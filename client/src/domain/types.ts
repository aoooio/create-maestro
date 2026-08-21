/**
 * Core domain types, mirroring `server/internal/domain/session`.
 *
 * This module — and every module in `src/domain` — is pure TypeScript: no
 * React, no `window`, no wire format. That is what makes the timing rules
 * testable without a browser, and it is enforced by `architecture.test.ts`.
 */

export type SessionId = string;
export type ParticipantId = string;
export type JoinCode = string;
export type TrackId = string;

/** Groups are numbered from 1; 0 is the maestro, who belongs to no group. */
export type GroupId = number;
export const NO_GROUP: GroupId = 0;

export type Role = "maestro" | "musician";
export type PlayState = "playing" | "stopped";

/**
 * Pins a musical position to an instant of server time. Deriving the position
 * from the latest anchor is what keeps a tempo change from rewriting the past.
 */
export interface TempoAnchor {
  readonly atServerMs: number;
  readonly atBeat: number;
  readonly bpm: number;
}

export interface Transport {
  readonly state: PlayState;
  readonly anchor: TempoAnchor;
  readonly beatsPerBar: number;
  readonly stepsPerBeat: number;
  readonly generation: number;
}

export interface Step {
  readonly on: boolean;
  readonly velocity: number;
  /** MIDI pitch of the cell. Meaningless on a percussive track, which is why
   * it never has to be sent for one. */
  readonly note: number;
}

export interface Pattern {
  readonly trackId: TrackId;
  readonly steps: readonly Step[];
  readonly generation: number;
}

/** One step of the grid, resolved to the instant it must sound. */
export interface StepEvent {
  readonly serverMs: number;
  /** Absolute step index since beat 0 — monotonic, and the scheduler's cursor. */
  readonly index: number;
  /** Position of the step inside its bar, which is what a pattern indexes by. */
  readonly stepInBar: number;
  readonly bar: number;
  readonly beat: number;
  /** How long this step lasts, at the tempo that governs it. A sustained voice
   * needs a gate length, and taking it from the transport "in force" would be
   * wrong for a step planned past an announced tempo change (§5.4) — so it is
   * resolved here, with the anchor the step was actually placed against. */
  readonly secondsPerStep: number;
}

/** A musical position projected onto the bar/step grid of a transport. */
export interface Position {
  readonly bar: number;
  readonly beatInBar: number;
  readonly stepInBar: number;
  readonly beat: number;
}

export interface GroupCount {
  readonly id: GroupId;
  readonly label: string;
  readonly count: number;
}

/** The audience of a parameter: everyone, or one group. */
export interface ParameterTarget {
  readonly group: GroupId;
}

export type ParameterValue = number | boolean;

export interface ParameterEntry {
  readonly key: string;
  readonly value: ParameterValue;
  readonly target: ParameterTarget;
}

export interface Participant {
  readonly id: ParticipantId;
  readonly name: string;
  readonly role: Role;
  readonly group: GroupId;
}

/** Protocol error codes, as emitted by the Go server. */
export type ErrorCode =
  | "unauthorized"
  | "forbidden_role"
  | "session_not_found"
  | "session_full"
  | "invalid_payload"
  | "rate_limited"
  | "protocol_version"
  | "internal";

export interface ProtocolError {
  readonly code: ErrorCode | string;
  readonly message: string;
  readonly retryable: boolean;
}
