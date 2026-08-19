"use client";

/**
 * The full-screen stage behind the musician's controls.
 *
 * One animation frame loop drives everything: it reads the shared clock, the
 * analyser and the local parameter, and hands the scene a plain set of
 * numbers. No React state is involved — a render per frame would cost more
 * than the scene itself.
 */

import { useEffect, useRef } from "react";

import type { SessionController } from "@/application/session";
import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { sceneInputs } from "@/infrastructure/visual/reactors";
import { createFallbackScene, createWireframeScene, hasWebGL, type Visual } from "@/infrastructure/visual/scene";

export function WireframeStage({
  controller,
  color,
}: {
  controller: SessionController | null;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !controller) return;

    // No WebGL is not a failure mode here: the fallback draws the same
    // vocabulary in 2D, so the picture degrades in detail, not in identity.
    const visual: Visual =
      (hasWebGL() ? createWireframeScene(canvas, color) : null) ??
      createFallbackScene(canvas, color);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      visual.resize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const levels = new Uint8Array(256);
    let raf = 0;
    const loop = () => {
      visual.render(
        sceneInputs({
          timeline: useSessionStore.getState().timeline,
          serverNowMs: controller.serverNowMs(),
          level: controller.level(levels),
          param: useAudioStore.getState().localParam,
        }),
      );
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // A hidden tab should not be rendering: the audio keeps its own clock.
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState === "visible") raf = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      visual.dispose();
    };
  }, [controller, color]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 h-full w-full"
    />
  );
}
