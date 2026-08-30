/**
 * Engine state: what is loaded, what is running, and how good the shared clock
 * currently is. Kept apart from the protocol state because it changes for
 * entirely local reasons — an iOS interruption, a sample still decoding — and
 * nothing here is ever sent to anyone.
 */

import { create } from "zustand";

import type { GroupId } from "@/domain/types";
import type { SyncQuality } from "@/infrastructure/clock/clockSync";

export type EngineStage = "idle" | "unlocking" | "loading" | "ready" | "failed";

export interface AudioState {
  stage: EngineStage;
  /** 0..1, drives the `[████░░░░]` bar. */
  progress: number;
  failure: string | null;

  /** Capabilities decided once, at entry: they also go in the `hello`. */
  hasWebAudio: boolean;
  hasWebGL: boolean;

  syncQuality: SyncQuality;
  offsetMs: number;
  rttMs: number;
  samples: number;

  /** The musician's own parameter (§6.3): local, never sent on the wire. */
  localParam: number;
  /** Fades the master bus out after a long disconnection (§6.5). */
  offline: boolean;
  /** The AudioContext is not running — iOS needs another tap to resume. */
  needsResume: boolean;
  /**
   * Group layers the maestro is auditioning on this console. Strictly local,
   * like `localParam`: monitoring is how the maestro hears what they are
   * writing, and it must not change one note of what the room plays.
   */
  monitorGroups: ReadonlySet<GroupId>;

  setStage: (stage: EngineStage) => void;
  setProgress: (progress: number) => void;
  fail: (reason: string) => void;
  setCapabilities: (caps: { hasWebAudio: boolean; hasWebGL: boolean }) => void;
  setSync: (sync: { quality: SyncQuality; offsetMs: number; rttMs: number; samples: number }) => void;
  setLocalParam: (value: number) => void;
  setOffline: (offline: boolean) => void;
  setNeedsResume: (needsResume: boolean) => void;
  toggleMonitor: (group: GroupId) => void;
  reset: () => void;
}

function initialState() {
  return {
    stage: "idle" as EngineStage,
    progress: 0,
    failure: null,
    hasWebAudio: true,
    hasWebGL: true,
    syncQuality: "unknown" as SyncQuality,
    offsetMs: 0,
    rttMs: 0,
    samples: 0,
    localParam: 0.5,
    offline: false,
    needsResume: false,
    monitorGroups: new Set<GroupId>() as ReadonlySet<GroupId>,
  };
}

export const useAudioStore = create<AudioState>((set) => ({
  ...initialState(),

  setStage: (stage) => set({ stage }),
  setProgress: (progress) => set({ progress }),
  fail: (failure) => set({ stage: "failed", failure }),
  setCapabilities: (caps) => set(caps),
  setSync: ({ quality, offsetMs, rttMs, samples }) =>
    set({ syncQuality: quality, offsetMs, rttMs, samples }),
  setLocalParam: (localParam) => set({ localParam }),
  setOffline: (offline) => set({ offline }),
  setNeedsResume: (needsResume) => set({ needsResume }),
  toggleMonitor: (group) =>
    set((state) => {
      // A new Set every time: subscribers compare by identity, and a mutated
      // one would leave the console's MONITOR button showing the old state.
      const next = new Set(state.monitorGroups);
      if (!next.delete(group)) next.add(group);
      return { monitorGroups: next };
    }),
  reset: () => set(initialState()),
}));
