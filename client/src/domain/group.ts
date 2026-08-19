/** Port of the group/target half of `server/internal/domain/session/group.go`,
 * plus the client-side coding of a group: a phosphor, a glyph and a label.
 * Colour is never the only carrier — the label and the glyph always go with it. */

import { NO_GROUP, type GroupId, type ParameterTarget } from "./types";

export function targetAll(): ParameterTarget {
  return { group: NO_GROUP };
}

export function targetGroup(group: GroupId): ParameterTarget {
  return { group };
}

export function isAll(target: ParameterTarget): boolean {
  return target.group === NO_GROUP;
}

/** Canonical wire spelling: "all" or "group:2". */
export function formatTarget(target: ParameterTarget): string {
  return isAll(target) ? "all" : `group:${target.group}`;
}

export function parseTarget(raw: string): ParameterTarget {
  if (raw === "" || raw === "all") return targetAll();
  const suffix = raw.startsWith("group:") ? raw.slice("group:".length) : null;
  const id = suffix === null ? Number.NaN : Number.parseInt(suffix, 10);
  if (!Number.isInteger(id) || id < 1 || id > 255) {
    throw new Error(`unknown parameter target "${raw}"`);
  }
  return targetGroup(id);
}

/** Visual identity of a group. Phosphors cycle for a hypothetical third
 * register: the domain handles N groups, so this must not break at two. */
export interface GroupSkin {
  readonly color: string;
  readonly glyph: string;
  readonly cssVar: string;
}

const SKINS: readonly GroupSkin[] = [
  { color: "#33ff66", glyph: "▲", cssVar: "var(--color-phosphor)" },
  { color: "#33ffff", glyph: "●", cssVar: "var(--color-phosphor-cyan)" },
  { color: "#ffb000", glyph: "■", cssVar: "var(--color-phosphor-amber)" },
];

const MAESTRO_SKIN: GroupSkin = {
  color: "#33ff66",
  glyph: "◆",
  cssVar: "var(--color-phosphor)",
};

export function groupSkin(group: GroupId): GroupSkin {
  if (group === NO_GROUP) return MAESTRO_SKIN;
  return SKINS[(group - 1) % SKINS.length]!;
}

/** Full badge text, e.g. "▲ GROUPE 1 · HIGH". */
export function groupBadge(group: GroupId, label: string): string {
  if (group === NO_GROUP) return `${MAESTRO_SKIN.glyph} MAESTRO`;
  return `${groupSkin(group).glyph} GROUPE ${group} · ${label}`;
}
