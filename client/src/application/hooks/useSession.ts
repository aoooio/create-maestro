"use client";

/**
 * React's view of a session: create the controller, connect it, take it down
 * on unmount. Nothing else in the component tree ever holds a socket.
 */

import { useEffect, useRef, useState } from "react";

import { SessionController, type SessionControllerOptions } from "@/application/session";
import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { hasWebGL } from "@/infrastructure/visual/scene";

export function useSessionController(
  options: SessionControllerOptions | null,
): SessionController | null {
  const [controller, setController] = useState<SessionController | null>(null);
  // The trigger sink changes identity on every render; keeping the latest one
  // in a ref means a new callback does not tear the connection down.
  const onTrigger = useRef(options?.onTrigger);
  useEffect(() => {
    onTrigger.current = options?.onTrigger;
  });

  const url = options?.url;
  const role = options?.role;
  const name = options?.name;

  useEffect(() => {
    if (!url || !role) return;

    useSessionStore.getState().reset();
    const instance = new SessionController({
      url,
      role,
      name,
      onTrigger: (trigger) => onTrigger.current?.(trigger),
    });
    instance.connect();
    setController(instance);

    return () => {
      instance.dispose();
      setController(null);
      useSessionStore.getState().reset();
      useAudioStore.getState().reset();
    };
  }, [url, role, name]);

  return controller;
}

/** Capability detection, once, at entry. The results go into the `hello` so
 * the server's logs know what the room is actually running. */
export function useCapabilities(): void {
  useEffect(() => {
    useAudioStore.getState().setCapabilities({
      hasWebAudio:
        typeof window !== "undefined" &&
        Boolean(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext),
      hasWebGL: hasWebGL(),
    });
  }, []);
}

/**
 * Keeps the screen awake while playing, and re-acquires the lock after the
 * page comes back from the background — a wake lock is released on hide, and
 * a musician who put their phone down mid-set should not find it locked.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied, unsupported, or the page is not visible: not worth surfacing.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !cancelled) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
    };
  }, [active]);
}
