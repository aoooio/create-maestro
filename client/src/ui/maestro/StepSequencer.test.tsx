// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionController } from "@/application/session";
import { useSessionStore } from "@/application/store/sessionStore";
import type { ServerMessage } from "@/infrastructure/ws/codec";

import { StepSequencer } from "./StepSequencer";

function fakeController() {
  return {
    serverNowMs: () => 0,
    setPattern: vi.fn(),
  } as unknown as SessionController & { setPattern: ReturnType<typeof vi.fn> };
}

function snapshot(generation: number, kickSteps: boolean[]): ServerMessage {
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
      patterns: [
        {
          trackId: "kick",
          steps: kickSteps.map((on) => ({ on, velocity: on ? 1 : 0, note: 36 })),
          generation,
        },
      ],
      groups: [],
      generation,
      serverTimeMs: 0,
    },
  };
}

/** `step` is the 1-based number the cell announces, as a user would read it. */
function kickCell(step: number): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^KICK pas ${step} `) });
}

/** The controller pushes server messages into the store from outside React;
 * in a test that has to happen inside `act` for the render to flush. */
function receive(message: ServerMessage): void {
  act(() => {
    useSessionStore.getState().apply(message);
  });
}

beforeEach(() => {
  useSessionStore.getState().reset();
});

describe("StepSequencer", () => {
  it("draws the grid the server sent", () => {
    receive(snapshot(5, [true, false, false, false]));
    render(<StepSequencer controller={fakeController()} />);

    expect(kickCell(1)).toHaveAttribute("aria-pressed", "true");
    expect(kickCell(2)).toHaveAttribute("aria-pressed", "false");
  });

  it("flips a cell under the finger and sends the whole grid", async () => {
    const controller = fakeController();
    receive(snapshot(5, [true, false, false, false]));
    render(<StepSequencer controller={controller} />);

    await userEvent.click(kickCell(3));

    // Optimistic: the console does not wait for a round trip to show the edit.
    expect(kickCell(3)).toHaveAttribute("aria-pressed", "true");
    expect(controller.setPattern).toHaveBeenCalledTimes(1);
    const [trackId, steps] = controller.setPattern.mock.calls[0]!;
    expect(trackId).toBe("kick");
    expect((steps as { on: boolean }[]).map((step) => step.on).slice(0, 4)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("lets the server's echo replace the local draft", async () => {
    receive(snapshot(5, [true, false, false, false]));
    render(<StepSequencer controller={fakeController()} />);

    await userEvent.click(kickCell(3));
    expect(kickCell(3)).toHaveAttribute("aria-pressed", "true");

    // The server answers with a newer generation that does not contain the
    // edit — a rejection, or someone else's change. §4.4 says the server wins,
    // and the draft has to go rather than fight it.
    receive({
      type: "pattern.updated",
      data: {
        pattern: {
          trackId: "kick",
          steps: [true, false, false, false].map((on) => ({ on, velocity: on ? 1 : 0, note: 36 })),
          generation: 6,
        },
        generation: 6,
      },
    });

    expect(kickCell(3)).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the draft while the server has not answered yet", async () => {
    receive(snapshot(5, [false, false, false, false]));
    render(<StepSequencer controller={fakeController()} />);

    await userEvent.click(kickCell(1));
    // An unrelated change bumping the generation of another track must not
    // wipe an edit still in flight.
    receive({
      type: "pattern.updated",
      data: {
        pattern: {
          trackId: "hat",
          steps: [{ on: true, velocity: 1, note: 36 }],
          generation: 6,
        },
        generation: 6,
      },
    });

    expect(kickCell(1)).toHaveAttribute("aria-pressed", "true");
  });
});

/** The pitched lane, which the drum lanes know nothing about. */
function bassSnapshot(generation: number, notes: number[], root = 0): ServerMessage {
  const base = snapshot(generation, [false, false, false, false]);
  if (base.type !== "state.snapshot") throw new Error("wrong type");
  return {
    ...base,
    data: {
      ...base.data,
      params: [{ key: "bassRoot", value: root, target: { group: 0 } }],
      patterns: [
        ...base.data.patterns,
        {
          trackId: "bass",
          steps: notes.map((note) => ({ on: true, velocity: 1, note })),
          generation,
        },
      ],
    },
  };
}

function bassCell(step: number): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^BASS pas ${step} `) });
}

describe("StepSequencer — piste BASS", () => {
  it("announces the note of each cell", () => {
    receive(bassSnapshot(5, [36, 43]));
    render(<StepSequencer controller={fakeController()} />);

    expect(bassCell(1)).toHaveAccessibleName(/note C2/);
    expect(bassCell(2)).toHaveAccessibleName(/note G2/);
  });

  it("raises a note by a semitone on ArrowUp, an octave with Shift", async () => {
    const controller = fakeController();
    receive(bassSnapshot(5, [36, 43]));
    render(<StepSequencer controller={controller} />);

    bassCell(1).focus();
    await userEvent.keyboard("{ArrowUp}");

    const [trackId, steps] = controller.setPattern.mock.calls[0]!;
    expect(trackId).toBe("bass");
    expect((steps as { note: number }[])[0]!.note).toBe(37);
    // And the edit shows before any round trip, like a cell toggle does.
    expect(bassCell(1)).toHaveAccessibleName(/note C#2/);

    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(bassCell(1)).toHaveAccessibleName(/note C#3/);
  });

  it("keeps the note when a cell is switched off and back on", async () => {
    const controller = fakeController();
    receive(bassSnapshot(5, [43]));
    render(<StepSequencer controller={controller} />);

    await userEvent.click(bassCell(1));
    await userEvent.click(bassCell(1));

    const [, steps] = controller.setPattern.mock.calls.at(-1)!;
    expect((steps as { on: boolean; note: number }[])[0]).toMatchObject({ on: true, note: 43 });
  });

  it("toggles the accent with Shift+Enter", async () => {
    const controller = fakeController();
    receive(bassSnapshot(5, [36]));
    render(<StepSequencer controller={controller} />);

    bassCell(1).focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

    const [, steps] = controller.setPattern.mock.calls[0]!;
    // Down from full: the cell arrived accented, so the first press plains it.
    expect((steps as { velocity: number }[])[0]!.velocity).toBeLessThan(0.9);
    expect(bassCell(1)).not.toHaveAccessibleName(/accentué/);
  });

  it("shows the transposed pitch, as that is what will sound", () => {
    receive(bassSnapshot(5, [36], 2));
    render(<StepSequencer controller={fakeController()} />);

    expect(bassCell(1)).toHaveAccessibleName(/note D2/);
  });

  it("leaves the drum lanes without a note in their label", () => {
    receive(bassSnapshot(5, [36]));
    render(<StepSequencer controller={fakeController()} />);

    expect(kickCell(1)).not.toHaveAccessibleName(/note/);
  });
});
