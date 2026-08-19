// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";

import { OfflineBanner, SyncBadge } from "./SyncBadge";

beforeEach(() => {
  useSessionStore.getState().reset();
  useAudioStore.getState().reset();
});

describe("SyncBadge", () => {
  it("says the state in words, not only in colour", () => {
    useSessionStore.getState().setConnection("open");
    useAudioStore.getState().setSync({ quality: "poor", offsetMs: 0, rttMs: 240, samples: 6 });
    render(<SyncBadge />);

    // A colour-blind reader, a monochrome screen and a screen reader all get
    // the same information (§7).
    expect(screen.getByText(/EN LIGNE/)).toBeInTheDocument();
    expect(screen.getByText(/SYNC DÉGRADÉE/)).toBeInTheDocument();
  });

  it("counts the reconnection attempts", () => {
    useSessionStore.getState().setConnection("reconnecting", 3);
    render(<SyncBadge />);
    expect(screen.getByText(/RECONNEXION 3/)).toBeInTheDocument();
  });

  it("is announced as it changes", () => {
    render(<SyncBadge />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });
});

describe("OfflineBanner", () => {
  it("stays out of the way while the socket is up", () => {
    useSessionStore.getState().setConnection("open");
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the sound carries on, which is the point of §6.5", () => {
    useSessionStore.getState().setConnection("reconnecting", 1);
    render(<OfflineBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/le son continue/i);
  });

  it("raises an unrecoverable refusal as an alert", () => {
    useSessionStore.getState().setFatal("protocol_version", "server speaks 2");
    render(<OfflineBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent(/RAFRAÎCHISSEZ LA PAGE/);
  });
});
