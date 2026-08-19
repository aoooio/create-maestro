"use client";

/**
 * The tube every page sits inside: scanlines, a vignette, and a very slight
 * scan wobble.
 *
 * Two constraints shaped this. It has to be free — the musician's phone owes
 * its frames to the wireframe scene, so the effects are two gradients and no
 * filter. And it has to be optional: `prefers-reduced-motion` removes the
 * wobble entirely, and a coarse pointer (a phone) keeps only the scanlines.
 */

import { useSyncExternalStore } from "react";

export interface CrtScreenProps {
  children: React.ReactNode;
  /** Effects off entirely — used behind the 3D stage, where a scanline overlay
   * would fight the scene's own persistence. */
  bare?: boolean;
  className?: string;
}

export function CrtScreen({ children, bare = false, className = "" }: CrtScreenProps) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className={`relative min-h-dvh bg-screen ${className}`}>
      {children}
      {!bare && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.28) 3px, rgba(0,0,0,0.28) 4px)",
            animation: reducedMotion ? undefined : "crt-scan 7.5s linear infinite",
          }}
        />
      )}
      {!bare && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,0.55) 100%)",
          }}
        />
      )}
      <style>{`@keyframes crt-scan { from { background-position-y: 0; } to { background-position-y: 4px; } }`}</style>
    </div>
  );
}

/** The media query is an external store, so it is read as one: no effect, no
 * flash of the wrong answer on the first frame. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, readReducedMotion, () => false);
}

function reducedMotionQuery(): MediaQueryList {
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion(): boolean {
  return reducedMotionQuery().matches;
}
