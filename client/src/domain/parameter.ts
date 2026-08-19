/** Port of `server/internal/domain/session/parameter.go`: same registry, same
 * bounds, same defaults. Clamping here means the console never sends a value
 * the server will silently rewrite. */

import type { ParameterEntry, ParameterTarget, ParameterValue } from "./types";
import { formatTarget } from "./group";

export type ParameterKey =
  | "cutoff"
  | "resonance"
  | "density"
  | "gain"
  | "reverb"
  | "delay"
  | "mute";

export type ParameterKind = "continuous" | "bool";

export interface ParameterSpec {
  readonly key: ParameterKey;
  readonly kind: ParameterKind;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  /** Shown in the console; the server has no use for it. */
  readonly label: string;
}

export const PARAMETER_REGISTRY: Readonly<Record<ParameterKey, ParameterSpec>> = {
  cutoff: { key: "cutoff", kind: "continuous", min: 0, max: 1, default: 1, label: "CUTOFF" },
  resonance: { key: "resonance", kind: "continuous", min: 0, max: 1, default: 0, label: "RESO" },
  density: { key: "density", kind: "continuous", min: 0, max: 1, default: 0.5, label: "DENSITY" },
  gain: { key: "gain", kind: "continuous", min: 0, max: 1, default: 0.8, label: "GAIN" },
  reverb: { key: "reverb", kind: "continuous", min: 0, max: 1, default: 0.2, label: "REVERB" },
  delay: { key: "delay", kind: "continuous", min: 0, max: 1, default: 0, label: "DELAY" },
  mute: { key: "mute", kind: "bool", min: 0, max: 1, default: 0, label: "MUTE" },
};

export const PARAMETER_KEYS = Object.keys(PARAMETER_REGISTRY) as ParameterKey[];

export function isParameterKey(key: string): key is ParameterKey {
  return Object.hasOwn(PARAMETER_REGISTRY, key);
}

export function lookupParameter(key: string): ParameterSpec | undefined {
  return isParameterKey(key) ? PARAMETER_REGISTRY[key] : undefined;
}

/** Clamps a raw input into the bounds of the spec, as `ParameterSpec.Value`
 * does server-side. Booleans go through the same path via 0/1. */
export function clampParameter(spec: ParameterSpec, raw: number): ParameterValue {
  if (spec.kind === "bool") return raw !== 0;
  return Math.min(spec.max, Math.max(spec.min, raw));
}

export function defaultValue(spec: ParameterSpec): ParameterValue {
  return clampParameter(spec, spec.default);
}

/** Numeric view of a value, for a gain node or a slider. */
export function asNumber(value: ParameterValue): number {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

/** Key under which an entry is stored: a parameter is scoped to its target. */
export function parameterSlot(key: string, target: ParameterTarget): string {
  return `${formatTarget(target)}#${key}`;
}

/**
 * Value in force for a group: its own scope when set, otherwise the session
 * scope, otherwise the domain default. Group scope shadowing "all" is exactly
 * how the server stores it.
 */
export function effectiveParameter(
  params: ReadonlyMap<string, ParameterEntry>,
  key: ParameterKey,
  group: number,
): ParameterValue {
  const scoped = params.get(parameterSlot(key, { group }));
  if (scoped) return scoped.value;
  const all = params.get(parameterSlot(key, { group: 0 }));
  if (all) return all.value;
  return defaultValue(PARAMETER_REGISTRY[key]);
}
