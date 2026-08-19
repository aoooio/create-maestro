// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrtScreen } from "./CrtScreen";

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/** The scanline layer is the one with the repeating gradient. */
function scanlines(container: HTMLElement): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>("div[aria-hidden]")].find((node) =>
    node.style.backgroundImage.includes("repeating-linear-gradient"),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CrtScreen", () => {
  it("renders its content, whatever the effects do", () => {
    mockReducedMotion(false);
    render(
      <CrtScreen>
        <p>console</p>
      </CrtScreen>,
    );
    expect(screen.getByText("console")).toBeInTheDocument();
  });

  it("animates the scan by default", () => {
    mockReducedMotion(false);
    const { container } = render(<CrtScreen>x</CrtScreen>);
    expect(scanlines(container)?.style.animation).toContain("crt-scan");
  });

  it("drops the motion when the reader asks for less of it", () => {
    mockReducedMotion(true);
    const { container } = render(<CrtScreen>x</CrtScreen>);
    // The scanlines stay — they are texture, not movement — but nothing moves.
    expect(scanlines(container)).toBeDefined();
    expect(scanlines(container)?.style.animation).toBe("");
  });

  it("takes the overlays away behind the 3D stage", () => {
    mockReducedMotion(false);
    const { container } = render(<CrtScreen bare>x</CrtScreen>);
    expect(scanlines(container)).toBeUndefined();
  });

  it("keeps the overlays out of the pointer's way", () => {
    mockReducedMotion(false);
    const { container } = render(<CrtScreen>x</CrtScreen>);
    for (const overlay of container.querySelectorAll("div[aria-hidden]")) {
      expect(overlay.className).toContain("pointer-events-none");
    }
  });
});
