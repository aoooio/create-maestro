/**
 * The mapping from musical state to what the scene is asked to draw.
 *
 * It is separate from `scene.ts` because it is the part with an opinion — and
 * the part worth testing. Whether the ring spins is a matter of taste; that
 * the flash lands on the downbeat and not a frame later is not.
 */

import { beatAt, transportAt, type Timeline } from "@/domain/transport";
import type { SceneInputs } from "./scene";

export interface ReactorState {
  timeline: Timeline;
  serverNowMs: number;
  /** 0..1 from the analyser. */
  level: number;
  /** The musician's own parameter, 0..1. */
  param: number;
}

export function sceneInputs(state: ReactorState): SceneInputs {
  const transport = transportAt(state.timeline, state.serverNowMs);
  const beat = beatAt(transport, state.serverNowMs);
  return {
    beat,
    // Phase inside the beat, always in [0, 1) — including before beat zero,
    // where a plain `beat % 1` would go negative and invert the flash.
    beatPhase: ((beat % 1) + 1) % 1,
    level: clamp01(state.level),
    param: clamp01(state.param),
    playing: transport.state === "playing",
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
