"use client";

/**
 * The playhead, at 60 fps, without a single React render (§6.2).
 *
 * The sequencer moves sixteen times a bar and the scene every frame; putting
 * either through `useState` would re-render the console several times a second
 * for the whole set. So the loop reads the transport, computes the position,
 * and hands it to a callback that writes straight to the DOM or to a canvas.
 */

import { useEffect, useRef } from "react";

import { useSessionStore } from "@/application/store/sessionStore";
import { beatAt, transportAt } from "@/domain/transport";
import { positionAt } from "@/domain/musicalTime";
import type { Position } from "@/domain/types";

export interface TransportFrame extends Position {
  serverMs: number;
  playing: boolean;
  /** 0..1 through the current beat. */
  beatPhase: number;
}

/**
 * Takes the controller rather than a closure over it: a `() => …` argument
 * would have a new identity on every render, tearing the loop down and
 * rebuilding it sixty times a second.
 */
export function useTransportPosition(
  controller: { serverNowMs: () => number } | null,
  onFrame: (frame: TransportFrame) => void,
): void {
  const callback = useRef(onFrame);
  useEffect(() => {
    callback.current = onFrame;
  });

  useEffect(() => {
    if (!controller) return;
    let raf = 0;

    const loop = () => {
      const serverMs = controller.serverNowMs();
      // Read the store imperatively: subscribing here would defeat the point.
      const timeline = useSessionStore.getState().timeline;
      const transport = transportAt(timeline, serverMs);
      const beat = beatAt(transport, serverMs);
      const position = positionAt(beat, transport.beatsPerBar, transport.stepsPerBeat);

      callback.current({
        ...position,
        serverMs,
        playing: transport.state === "playing",
        beatPhase: ((beat % 1) + 1) % 1,
      });

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [controller]);
}
