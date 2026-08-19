/**
 * Engine state: what is loaded, what is running, and how good the shared clock
 * currently is. Kept apart from the protocol state because it changes for
 * entirely local reasons — an iOS interruption, a sample still decoding — and
 * nothing here is ever sent to anyone.
 */

import { create } from "zustand";

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

  setStage: (stage: EngineStage) => void;
  setProgress: (progress: number) => void;
  fail: (reason: string) => void;
  setCapabilities: (caps: { hasWebAudio: boolean; hasWebGL: boolean }) => void;
  setSync: (sync: { quality: SyncQuality; offsetMs: number; rttMs: number; samples: number }) => void;
  setLocalParam: (value: number) => void;
  setOffline: (offline: boolean) => void;
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
  reset: () => set(initialState()),
}));
