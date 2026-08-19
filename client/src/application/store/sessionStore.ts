/**
 * Protocol state, and the one rule that keeps it honest (§4.4): a state
 * message is applied only if its `generation` is newer than what we hold, and
 * a `state.snapshot` *replaces* the state instead of merging into it. A late
 * message is dropped, and a reconnection resyncs by replacement — never by
 * reconciling two histories.
 */

import { create } from "zustand";

import { parameterSlot } from "@/domain/parameter";
import {
  newTimeline,
  newTransport,
  schedule,
  settle,
  type Timeline,
} from "@/domain/transport";
import type {
  GroupCount,
  GroupId,
  ParameterEntry,
  ParticipantId,
  Pattern,
  Role,
  SessionId,
  TrackId,
} from "@/domain/types";
import type { ConnectionState } from "@/infrastructure/ws/client";
import type { ServerMessage } from "@/infrastructure/ws/codec";

export interface RosterEntry {
  id: ParticipantId;
  name: string;
  role: string;
  group: GroupId;
  joinedAtMs: number;
}

export interface SessionState {
  connection: ConnectionState;
  reconnectAttempt: number;
  fatal: { reason: string; message: string } | null;
  lastError: { code: string; message: string; atMs: number } | null;

  sessionId: SessionId | null;
  participantId: ParticipantId | null;
  role: Role | null;
  groupId: GroupId;
  groupLabel: string;

  timeline: Timeline;
  generation: number;
  params: ReadonlyMap<string, ParameterEntry>;
  patterns: ReadonlyMap<TrackId, Pattern>;
  groups: readonly GroupCount[];
  /** Arrivals seen since this client connected. The authoritative population
   * is `groups`; this is the live log the maestro's wall scrolls. */
  roster: readonly RosterEntry[];

  apply: (message: ServerMessage) => void;
  setConnection: (state: ConnectionState, attempt?: number) => void;
  setFatal: (reason: string, message: string) => void;
  /** Folds a pending tempo change in once it is in the past; called by the
   * scheduler, and a no-op until the boundary is actually crossed. */
  settleTimeline: (serverMs: number) => void;
  reset: () => void;
}

const MAX_ROSTER = 200;

function initialState() {
  return {
    connection: "idle" as ConnectionState,
    reconnectAttempt: 0,
    fatal: null,
    lastError: null,
    sessionId: null,
    participantId: null,
    role: null,
    groupId: 0,
    groupLabel: "",
    timeline: newTimeline(newTransport(0, 120)) satisfies Timeline,
    generation: 0,
    params: new Map<string, ParameterEntry>(),
    patterns: new Map<TrackId, Pattern>(),
    groups: [] as readonly GroupCount[],
    roster: [] as readonly RosterEntry[],
  };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  ...initialState(),

  setConnection: (connection, attempt = 0) =>
    set({ connection, reconnectAttempt: attempt }),

  setFatal: (reason, message) => set({ fatal: { reason, message } }),

  settleTimeline: (serverMs) => {
    const { timeline } = get();
    const settled = settle(timeline, serverMs);
    if (settled !== timeline) set({ timeline: settled });
  },

  reset: () => set(initialState()),

  apply: (message) => {
    switch (message.type) {
      case "welcome": {
        const { participantId, sessionId, role, groupId } = message.data;
        set({ participantId, sessionId, role, groupId });
        return;
      }

      case "group.assigned": {
        set({ groupId: message.data.groupId, groupLabel: message.data.label });
        return;
      }

      case "state.snapshot": {
        // Wholesale replacement: after a reconnection the local state is
        // whatever the server says, with nothing carried over.
        const params = new Map<string, ParameterEntry>();
        for (const entry of message.data.params) {
          params.set(parameterSlot(entry.key, entry.target), entry);
        }
        const patterns = new Map<TrackId, Pattern>();
        for (const pattern of message.data.patterns) {
          patterns.set(pattern.trackId, pattern);
        }
        set({
          timeline: newTimeline(message.data.transport),
          generation: message.data.generation,
          params,
          patterns,
          groups: message.data.groups,
        });
        return;
      }

      case "transport.updated": {
        if (!isNewer(get().generation, message.data.generation)) return;
        // The change is announced for later: it joins the queue instead of
        // replacing what is currently sounding, so everything already
        // scheduled keeps the anchor it was planned with (§5.4). The scheduler
        // folds a change in once its boundary is behind us.
        set({
          timeline: schedule(get().timeline, {
            transport: message.data.transport,
            effectiveAtServerMs: message.data.effectiveAtServerMs,
          }),
          generation: message.data.generation,
        });
        return;
      }

      case "param.updated": {
        if (!isNewer(get().generation, message.data.generation)) return;
        const params = new Map(get().params);
        const { entry } = message.data;
        params.set(parameterSlot(entry.key, entry.target), entry);
        set({ params, generation: message.data.generation });
        return;
      }

      case "pattern.updated": {
        if (!isNewer(get().generation, message.data.generation)) return;
        const patterns = new Map(get().patterns);
        patterns.set(message.data.pattern.trackId, message.data.pattern);
        set({ patterns, generation: message.data.generation });
        return;
      }

      case "participant.joined": {
        const { participantId, name, role, groupId, counts } = message.data;
        const roster = [
          ...get().roster.filter((entry) => entry.id !== participantId),
          { id: participantId, name, role, group: groupId, joinedAtMs: Date.now() },
        ];
        set({
          groups: counts,
          roster: roster.slice(-MAX_ROSTER),
        });
        return;
      }

      case "participant.left": {
        set({
          groups: message.data.counts,
          roster: get().roster.filter((entry) => entry.id !== message.data.participantId),
        });
        return;
      }

      case "error": {
        set({
          lastError: {
            code: message.data.code,
            message: message.data.message,
            atMs: Date.now(),
          },
        });
        return;
      }

      // `time.pong` belongs to the clock, `participant.trigger` is ephemeral
      // and drives animations through refs: neither belongs in React state.
      default:
        return;
    }
  },
}));

/** §4.4: a state message counts only if it is strictly newer. */
function isNewer(local: number, incoming: number): boolean {
  return incoming > local;
}
