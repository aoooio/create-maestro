// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionController } from "@/application/session";
import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { noteForRow } from "@/domain/scale";
import type { Step } from "@/domain/types";
import type { ServerMessage } from "@/infrastructure/ws/codec";

import { NoteStripSequencer } from "./NoteStripSequencer";

function fakeController() {
  return {
    serverNowMs: () => 0,
    setPattern: vi.fn(),
    // The real one flips the store *and* pushes the change into the engine;
    // the store half is all the console can observe.
    toggleMonitor: vi.fn((group: number) => useAudioStore.getState().toggleMonitor(group)),
  } as unknown as SessionController & {
    setPattern: ReturnType<typeof vi.fn>;
    toggleMonitor: ReturnType<typeof vi.fn>;
  };
}

/** A snapshot carrying two groups and, optionally, a strip already written
 * for GROUP 1. */
function snapshot(generation: number, strip?: { steps: boolean[]; note: number }): ServerMessage {
  return {
    type: "state.snapshot",
    data: {
      transport: {
        state: "stopped",
        anchor: { atServerMs: 0, atBeat: 0, bpm: 120 },
        beatsPerBar: 4,
        stepsPerBeat: 4,
        generation,
      },
      params: [],
      patterns: strip
        ? [
            {
              trackId: "group1",
              steps: strip.steps.map((on) => ({
                on,
                velocity: on ? 1 : 0,
                note: strip.note,
              })),
              generation,
            },
          ]
        : [],
      groups: [
        { id: 1, label: "HIGH", count: 3 },
        { id: 2, label: "MID", count: 2 },
      ],
      generation,
      serverTimeMs: 0,
    },
  };
}

/** A cell, addressed the way the console announces it: a step number and the
 * pitch of its row. */
function cell(step: number, pitch: string, group = 1): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`^GROUPE ${group} pas ${step} ${pitch.replace("#", "\\#")},`),
  });
}

function receive(message: ServerMessage): void {
  act(() => {
    useSessionStore.getState().apply(message);
  });
}

/** Row 0 of GROUP 1 is A4 — the bottom line of its grid. */
const ROW0 = "A4";
/** Row 1 is three semitones up, the second degree of the pentatonic. */
const ROW1 = "C5";

beforeEach(() => {
  useSessionStore.getState().reset();
  useAudioStore.getState().reset();
});

describe("NoteStripSequencer", () => {
  it("waits for the state rather than inventing groups", () => {
    render(<NoteStripSequencer controller={fakeController()} />);
    expect(screen.getByText(/en attente de l’état/)).toBeInTheDocument();
  });

  it("draws one strip per group, sixteen steps by default", () => {
    receive(snapshot(5));
    render(<NoteStripSequencer controller={fakeController()} />);

    expect(screen.getByText(/GROUPE 1 · HIGH/)).toBeInTheDocument();
    expect(screen.getByText(/GROUPE 2 · MID/)).toBeInTheDocument();
    // Every cell of both grids starts empty.
    expect(cell(16, ROW0)).toHaveAttribute("aria-pressed", "false");
  });

  it("draws the note the server sent on the row it belongs to", () => {
    receive(snapshot(5, { steps: [true, false, false, false], note: noteForRow(1, 1) }));
    render(<NoteStripSequencer controller={fakeController()} />);

    expect(cell(1, ROW1)).toHaveAttribute("aria-pressed", "true");
    expect(cell(1, ROW0)).toHaveAttribute("aria-pressed", "false");
  });

  it("places the note of the row it was clicked on, and sends the whole strip", async () => {
    const controller = fakeController();
    receive(snapshot(5));
    render(<NoteStripSequencer controller={controller} />);

    await userEvent.click(cell(3, ROW1));

    // Optimistic: the console does not wait for a round trip to show the edit.
    expect(cell(3, ROW1)).toHaveAttribute("aria-pressed", "true");
    expect(controller.setPattern).toHaveBeenCalledTimes(1);
    const [trackId, steps] = controller.setPattern.mock.calls[0]! as [string, Step[]];
    expect(trackId).toBe("group1");
    expect(steps).toHaveLength(16);
    expect(steps[2]).toMatchObject({ on: true, note: noteForRow(1, 1) });
    expect(steps[0]!.on).toBe(false);
  });

  it("is monophonic: a second row in the same step moves the note", async () => {
    const controller = fakeController();
    receive(snapshot(5));
    render(<NoteStripSequencer controller={controller} />);

    await userEvent.click(cell(1, ROW0));
    await userEvent.click(cell(1, ROW1));

    expect(cell(1, ROW1)).toHaveAttribute("aria-pressed", "true");
    expect(cell(1, ROW0)).toHaveAttribute("aria-pressed", "false");
  });

  it("lifts a note when its own cell is clicked again", async () => {
    receive(snapshot(5));
    render(<NoteStripSequencer controller={fakeController()} />);

    await userEvent.click(cell(2, ROW0));
    expect(cell(2, ROW0)).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(cell(2, ROW0));
    expect(cell(2, ROW0)).toHaveAttribute("aria-pressed", "false");
  });

  it("accents a placed note on shift+click, and says so", async () => {
    // One session, so the held Shift is still down when the click lands.
    const user = userEvent.setup();
    const controller = fakeController();
    receive(snapshot(5));
    render(<NoteStripSequencer controller={controller} />);

    await user.click(cell(1, ROW0));
    await user.keyboard("{Shift>}");
    await user.click(cell(1, ROW0));
    await user.keyboard("{/Shift}");

    expect(cell(1, ROW0)).toHaveAccessibleName(/accentué/);
    const [, steps] = controller.setPattern.mock.calls.at(-1)! as [string, Step[]];
    expect(steps[0]!.velocity).toBe(1);
  });

  it("reaches the same accent from the keyboard", async () => {
    // Shift+Enter on a focused cell, the gesture the drum machine already
    // uses — the console has to be playable without a mouse.
    receive(snapshot(5));
    render(<NoteStripSequencer controller={fakeController()} />);

    await userEvent.click(cell(1, ROW0));
    cell(1, ROW0).focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

    expect(cell(1, ROW0)).toHaveAccessibleName(/accentué/);
  });

  it("resizes the strip to two and four bars", async () => {
    const controller = fakeController();
    receive(snapshot(5));
    render(<NoteStripSequencer controller={controller} />);

    await userEvent.click(screen.getByRole("button", { name: "Groupe 1 longueur 32 pas" }));

    const [trackId, steps] = controller.setPattern.mock.calls[0]! as [string, Step[]];
    expect(trackId).toBe("group1");
    expect(steps).toHaveLength(32);
    // The grid on screen grew with it.
    expect(cell(32, ROW0)).toBeInTheDocument();
  });

  it("keeps what fits when a strip is shortened", async () => {
    const controller = fakeController();
    receive(snapshot(5, { steps: [true, false, false, false], note: noteForRow(1, 0) }));
    render(<NoteStripSequencer controller={controller} />);

    await userEvent.click(screen.getByRole("button", { name: "Groupe 1 longueur 64 pas" }));
    const [, steps] = controller.setPattern.mock.calls[0]! as [string, Step[]];
    expect(steps).toHaveLength(64);
    expect(steps[0]!.on).toBe(true);
  });

  it("clears a strip without changing its length", async () => {
    const controller = fakeController();
    receive(snapshot(5, { steps: [true, true, false, false], note: noteForRow(1, 0) }));
    render(<NoteStripSequencer controller={controller} />);

    await userEvent.click(screen.getByRole("button", { name: "Effacer la bande du groupe 1" }));
    const [, steps] = controller.setPattern.mock.calls[0]! as [string, Step[]];
    expect(steps).toHaveLength(4);
    expect(steps.some((step) => step.on)).toBe(false);
  });

  it("lets the server's echo replace the local draft", async () => {
    receive(snapshot(5));
    render(<NoteStripSequencer controller={fakeController()} />);

    await userEvent.click(cell(3, ROW1));
    expect(cell(3, ROW1)).toHaveAttribute("aria-pressed", "true");

    // A newer generation that does not carry the edit — a rejection, or
    // someone else's change. §4.4 says the server wins.
    receive({
      type: "pattern.updated",
      data: {
        pattern: {
          trackId: "group1",
          steps: Array.from({ length: 16 }, () => ({ on: false, velocity: 0, note: 36 })),
          generation: 6,
        },
        generation: 6,
      },
    });

    expect(cell(3, ROW1)).toHaveAttribute("aria-pressed", "false");
  });

  it("monitors a group locally, without touching the wire", async () => {
    const controller = fakeController();
    receive(snapshot(5));
    render(<NoteStripSequencer controller={controller} />);

    const monitor = screen.getByRole("button", {
      name: "Écouter le groupe 1 sur cette console",
    });
    expect(monitor).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(monitor);

    expect(monitor).toHaveAttribute("aria-pressed", "true");
    expect(useAudioStore.getState().monitorGroups.has(1)).toBe(true);
    // Through the controller, not straight to the store: only the controller
    // pushes the change into the audio engine.
    expect(controller.toggleMonitor).toHaveBeenCalledWith(1);
    // Monitoring is what this console hears, not what the room plays.
    expect(controller.setPattern).not.toHaveBeenCalled();
  });
});
