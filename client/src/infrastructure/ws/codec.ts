/**
 * The only place where the protocol meets JSON — the mirror of
 * `server/internal/infrastructure/ws/codec.go`. Nothing above this file knows
 * the wire format, and nothing in it knows the business rules.
 *
 * Every inbound frame is validated with zod: a malformed message is reported
 * and dropped, never applied half-way. Unknown fields are ignored on purpose
 * (§4.1, forward compatibility), which is zod's default for objects.
 */

import { z } from "zod";

import { parseTarget } from "@/domain/group";
import { DEFAULT_BASS_NOTE } from "@/domain/note";
import type {
  GroupCount,
  ParameterEntry,
  Pattern,
  ProtocolError,
  Role,
  Transport,
} from "@/domain/types";

export const PROTOCOL_VERSION = 1;

// --- envelope (§4.1) ---

const envelopeSchema = z.object({
  v: z.number().optional(),
  t: z.string(),
  id: z.string().optional(),
  ack: z.string().optional(),
  ts: z.number().optional(),
  d: z.unknown().optional(),
});

// --- server → client payloads ---

const groupCountSchema = z.object({
  id: z.number(),
  label: z.string(),
  count: z.number(),
});

const anchorSchema = z.object({
  atServerMs: z.number(),
  atBeat: z.number(),
  bpm: z.number(),
});

const playStateSchema = z.union([z.literal("playing"), z.literal("stopped")]);

const transportSchema = z.object({
  anchor: anchorSchema,
  state: playStateSchema,
  beatsPerBar: z.number(),
  stepsPerBeat: z.number(),
  generation: z.number(),
});

const parameterValueSchema = z.union([z.number(), z.boolean()]);

const paramSchema = z.object({
  key: z.string(),
  value: parameterValueSchema,
  target: z.string(),
});

const patternSchema = z.object({
  trackId: z.string(),
  steps: z.array(z.boolean()),
  velocity: z.array(z.number()).optional(),
  note: z.array(z.number()).optional(),
  generation: z.number().optional(),
});

const payloadSchemas = {
  welcome: z.object({
    participantId: z.string(),
    sessionId: z.string(),
    role: z.union([z.literal("maestro"), z.literal("musician")]),
    groupId: z.number(),
    serverTimeMs: z.number(),
    protocolVersion: z.number(),
  }),
  "state.snapshot": z.object({
    transport: transportSchema,
    params: z.array(paramSchema),
    patterns: z.array(patternSchema),
    groups: z.array(groupCountSchema),
    generation: z.number(),
    serverTimeMs: z.number(),
  }),
  "time.pong": z.object({
    clientSendMs: z.number(),
    serverRecvMs: z.number(),
    serverSendMs: z.number(),
  }),
  "transport.updated": z.object({
    anchor: anchorSchema,
    state: playStateSchema,
    beatsPerBar: z.number(),
    stepsPerBeat: z.number(),
    effectiveAtServerMs: z.number(),
    generation: z.number(),
  }),
  "param.updated": z.object({
    key: z.string(),
    value: parameterValueSchema,
    target: z.string(),
    generation: z.number(),
  }),
  "pattern.updated": patternSchema.extend({ generation: z.number() }),
  "group.assigned": z.object({
    groupId: z.number(),
    label: z.string(),
    reason: z.string(),
  }),
  "participant.joined": z.object({
    participantId: z.string(),
    name: z.string(),
    role: z.string(),
    groupId: z.number(),
    counts: z.array(groupCountSchema),
  }),
  "participant.left": z.object({
    participantId: z.string(),
    name: z.string(),
    role: z.string(),
    groupId: z.number(),
    counts: z.array(groupCountSchema),
  }),
  "participant.trigger": z.object({
    participantId: z.string(),
    groupId: z.number(),
    kind: z.string(),
    intensity: z.number(),
    atBeat: z.number().optional(),
  }),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
} as const;

export type ServerMessageType = keyof typeof payloadSchemas;

/** A decoded server message, in domain terms wherever a domain type exists. */
export type ServerMessage =
  | { type: "welcome"; ack?: string; data: Welcome }
  | { type: "state.snapshot"; ack?: string; data: Snapshot }
  | { type: "time.pong"; ack?: string; data: TimePong }
  | { type: "transport.updated"; ack?: string; data: TransportUpdated }
  | { type: "param.updated"; ack?: string; data: ParamUpdated }
  | { type: "pattern.updated"; ack?: string; data: PatternUpdated }
  | { type: "group.assigned"; ack?: string; data: GroupAssigned }
  | { type: "participant.joined"; ack?: string; data: Presence }
  | { type: "participant.left"; ack?: string; data: Presence }
  | { type: "participant.trigger"; ack?: string; data: TriggerRelay }
  | { type: "error"; ack?: string; data: ProtocolError };

export interface Welcome {
  participantId: string;
  sessionId: string;
  role: Role;
  groupId: number;
  serverTimeMs: number;
  protocolVersion: number;
}

export interface Snapshot {
  transport: Transport;
  params: ParameterEntry[];
  patterns: Pattern[];
  groups: GroupCount[];
  generation: number;
  serverTimeMs: number;
}

export interface TimePong {
  clientSendMs: number;
  serverRecvMs: number;
  serverSendMs: number;
}

export interface TransportUpdated {
  transport: Transport;
  effectiveAtServerMs: number;
  generation: number;
}

export interface ParamUpdated {
  entry: ParameterEntry;
  generation: number;
}

export interface PatternUpdated {
  pattern: Pattern;
  generation: number;
}

export interface GroupAssigned {
  groupId: number;
  label: string;
  reason: string;
}

export interface Presence {
  participantId: string;
  name: string;
  role: string;
  groupId: number;
  counts: GroupCount[];
}

export interface TriggerRelay {
  participantId: string;
  groupId: number;
  kind: string;
  intensity: number;
  atBeat?: number;
}

/** Raised when the server speaks a protocol this client cannot read — the cue
 * for the "refresh the page" banner of §4.1. */
export class ProtocolVersionError extends Error {
  constructor(readonly version: number) {
    super(`the server speaks protocol version ${version}, this client speaks ${PROTOCOL_VERSION}`);
    this.name = "ProtocolVersionError";
  }
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/**
 * Parses one server frame. Throws `ProtocolVersionError` for a future
 * protocol, `DecodeError` for anything unreadable; both are handled by the
 * caller rather than silently swallowed here.
 */
export function decode(raw: string): ServerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DecodeError("malformed JSON frame");
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) throw new DecodeError("frame is not a protocol envelope");

  const { v, t, ack, d } = envelope.data;
  if (v !== undefined && v > PROTOCOL_VERSION) throw new ProtocolVersionError(v);

  const schema = payloadSchemas[t as ServerMessageType];
  if (!schema) throw new DecodeError(`unknown message type "${t}"`);

  const payload = schema.safeParse(d ?? {});
  if (!payload.success) {
    throw new DecodeError(`malformed ${t} payload: ${payload.error.message}`);
  }

  return { type: t as ServerMessageType, ack, data: toDomain(t as ServerMessageType, payload.data) } as ServerMessage;
}

function toDomain(type: ServerMessageType, data: unknown): unknown {
  switch (type) {
    case "state.snapshot": {
      const d = data as z.infer<(typeof payloadSchemas)["state.snapshot"]>;
      return {
        transport: toTransport(d.transport),
        params: d.params.map(toParameterEntry),
        patterns: d.patterns.map(toPattern),
        groups: d.groups,
        generation: d.generation,
        serverTimeMs: d.serverTimeMs,
      } satisfies Snapshot;
    }
    case "transport.updated": {
      const d = data as z.infer<(typeof payloadSchemas)["transport.updated"]>;
      return {
        transport: toTransport(d),
        effectiveAtServerMs: d.effectiveAtServerMs,
        generation: d.generation,
      } satisfies TransportUpdated;
    }
    case "param.updated": {
      const d = data as z.infer<(typeof payloadSchemas)["param.updated"]>;
      return {
        entry: toParameterEntry(d),
        generation: d.generation,
      } satisfies ParamUpdated;
    }
    case "pattern.updated": {
      const d = data as z.infer<(typeof payloadSchemas)["pattern.updated"]>;
      return { pattern: toPattern(d), generation: d.generation } satisfies PatternUpdated;
    }
    default:
      return data;
  }
}

function toTransport(d: z.infer<typeof transportSchema> | z.infer<(typeof payloadSchemas)["transport.updated"]>): Transport {
  return {
    state: d.state,
    anchor: d.anchor,
    beatsPerBar: d.beatsPerBar,
    stepsPerBeat: d.stepsPerBeat,
    generation: d.generation,
  };
}

function toParameterEntry(d: z.infer<typeof paramSchema>): ParameterEntry {
  return { key: d.key, value: d.value, target: parseTarget(d.target) };
}

function toPattern(d: z.infer<typeof patternSchema>): Pattern {
  return {
    trackId: d.trackId,
    steps: d.steps.map((on, i) => ({
      on,
      velocity: d.velocity?.[i] ?? (on ? 1 : 0),
      // A percussive track sends no pitch at all, and an older server sends
      // none for any track: either way the cell still needs a note to hold.
      note: d.note?.[i] ?? DEFAULT_BASS_NOTE,
    })),
    generation: d.generation ?? 0,
  };
}

// --- client → server ---

export type ClientMessage =
  | { t: "hello"; d: { name?: string; clientVersion: string; capabilities: { webaudio: boolean; webgl: boolean } } }
  | { t: "time.ping"; d: { clientSendMs: number } }
  | {
      t: "transport.set";
      d: {
        bpm?: number;
        state?: "playing" | "stopped";
        beatsPerBar?: number;
        stepsPerBeat?: number;
        alignTo: "bar" | "immediate";
      };
    }
  | {
      t: "pattern.set";
      d: { trackId: string; steps: boolean[]; velocity?: number[]; note?: number[] };
    }
  | { t: "param.set"; d: { key: string; value: number | boolean; target: string } }
  | { t: "trigger"; d: { kind: string; intensity: number; atBeat?: number } }
  | { t: "state.request"; d: Record<string, never> };

let messageCounter = 0;

/** Message id: unique per client, which is all the server's `ack` needs. */
export function newMessageId(): string {
  messageCounter = (messageCounter + 1) % 1_000_000;
  return `c${Date.now().toString(36)}${messageCounter.toString(36)}`;
}

export function encode(message: ClientMessage, nowMs: number): { id: string; frame: string } {
  const id = newMessageId();
  return {
    id,
    frame: JSON.stringify({
      v: PROTOCOL_VERSION,
      t: message.t,
      id,
      ts: Math.round(nowMs),
      d: message.d,
    }),
  };
}
