import { describe, expect, it } from "vitest";

import { formatTarget, groupBadge, groupSkin, parseTarget, targetAll, targetGroup } from "./group";

describe("parameter targets", () => {
  it("round-trips the canonical wire spelling", () => {
    expect(formatTarget(targetAll())).toBe("all");
    expect(formatTarget(targetGroup(2))).toBe("group:2");
    expect(parseTarget("all")).toEqual(targetAll());
    expect(parseTarget("")).toEqual(targetAll());
    expect(parseTarget("group:1")).toEqual(targetGroup(1));
  });

  it("refuses what the server refuses", () => {
    expect(() => parseTarget("group:0")).toThrow();
    expect(() => parseTarget("group:256")).toThrow();
    expect(() => parseTarget("everyone")).toThrow();
    expect(() => parseTarget("group:abc")).toThrow();
  });
});

describe("group coding", () => {
  it("gives each register its own phosphor and glyph", () => {
    expect(groupSkin(1).color).not.toBe(groupSkin(2).color);
    expect(groupSkin(1).glyph).not.toBe(groupSkin(2).glyph);
  });

  it("keeps working past the two registers of the default setup", () => {
    expect(groupSkin(4).color).toBe(groupSkin(1).color);
  });

  it("never leaves colour alone to carry the meaning", () => {
    expect(groupBadge(1, "HIGH")).toContain("GROUPE 1");
    expect(groupBadge(1, "HIGH")).toContain("HIGH");
    expect(groupBadge(0, "")).toContain("MAESTRO");
  });
});
