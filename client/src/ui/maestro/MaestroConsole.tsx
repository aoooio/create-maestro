"use client";

/**
 * The maestro's screen. It renders the base music locally, holds the authority
 * over the transport, and shows enough of the room's health to run a set from.
 *
 * Keyboard first: on a stage, in the dark, with one hand on a laptop, the
 * shortcuts are the interface and the mouse is the fallback.
 */

import { useCallback, useEffect, useState } from "react";

import { useSessionController, useCapabilities } from "@/application/hooks/useSession";
import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { clampBpm } from "@/domain/transport";
import { targetGroup } from "@/domain/group";
import { effectiveParameter } from "@/domain/parameter";
import { maestroUrl } from "@/infrastructure/ws/client";
import { wsBaseUrl } from "@/infrastructure/config";
import { CrtScreen } from "@/ui/shared/CrtScreen";
import { Meter, Panel } from "@/ui/shared/Panel";
import { OfflineBanner, SyncBadge } from "@/ui/shared/SyncBadge";

import { AcidBassPanel } from "./AcidBassPanel";
import { GroupMixer } from "./GroupMixer";
import { ParticipantWall, useTriggerSink } from "./ParticipantWall";
import { StepSequencer } from "./StepSequencer";
import { TempoDial } from "./TempoDial";

export function MaestroConsole({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  useCapabilities();
  const { sink, pulses } = useTriggerSink();
  const onTrigger = useCallback((trigger: Parameters<typeof sink.push>[0]) => sink.push(trigger), [sink]);

  const controller = useSessionController({
    url: maestroUrl(wsBaseUrl(), sessionId, token),
    role: "maestro",
    onTrigger,
  });

  const stage = useAudioStore((state) => state.stage);
  const progress = useAudioStore((state) => state.progress);
  const failure = useAudioStore((state) => state.failure);
  const [started, setStarted] = useState(false);

  useMaestroShortcuts(controller, started);

  async function start() {
    setStarted(true);
    await controller?.startAudio();
  }

  return (
    <CrtScreen>
      <OfflineBanner />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4">
        <ConsoleHeader sessionId={sessionId} />

        {stage !== "ready" ? (
          <Panel title="Console maestro">
            {failure ? (
              <p className="glow" style={{ color: "var(--color-phosphor-amber)" }}>
                ⚠ {failure}
              </p>
            ) : started ? (
              <div className="space-y-2">
                <Meter value={progress} label={stage === "loading" ? "chargement des voix" : "ouverture du contexte audio"} />
                <p className="text-dim text-xs">&gt; synchronisation de l’horloge…</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-dim text-sm">
                  Le navigateur n’autorise le son qu’après un geste. Rien ne sortira des
                  haut-parleurs avant celui-ci.
                </p>
                <button
                  type="button"
                  onClick={start}
                  className="glow-strong border border-current px-6 py-3 text-sm tracking-widest uppercase transition-colors hover:bg-phosphor hover:text-screen-deep"
                >
                  ▶ ouvrir la console
                </button>
              </div>
            )}
          </Panel>
        ) : null}

        <TempoDial controller={controller} />
        <StepSequencer controller={controller} />
        <AcidBassPanel controller={controller} />

        <div className="grid gap-3 lg:grid-cols-2">
          <GroupMixer controller={controller} />
          <ParticipantWall pulses={pulses} />
        </div>

        <HealthPanel controller={controller} />
      </main>
    </CrtScreen>
  );
}

/** The join code, big: it is what the room has to read off a screen. */
function ConsoleHeader({ sessionId }: { sessionId: string }) {
  const groups = useSessionStore((state) => state.groups);
  const [joinCode, setJoinCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((state: { joinCode?: string } | null) => {
        if (!cancelled && state?.joinCode) setJoinCode(state.joinCode);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-dimmer pb-3">
      <div>
        <h1 className="glow-strong text-lg tracking-[0.35em]">◆ MAESTRO</h1>
        <p className="text-[11px] text-dimmer">
          {groups.map((group) => `${group.label} ${group.count}`).join(" · ") || "session"}
        </p>
      </div>
      <div className="text-right">
        <p className="text-[10px] tracking-[0.3em] text-dim">CODE DE SESSION</p>
        <p className="glow-strong text-3xl tracking-[0.4em] tabular-nums">{joinCode ?? "····"}</p>
      </div>
      <SyncBadge />
    </header>
  );
}

function HealthPanel({ controller }: { controller: ReturnType<typeof useSessionController> }) {
  const groups = useSessionStore((state) => state.groups);
  const generation = useSessionStore((state) => state.generation);
  const lastError = useSessionStore((state) => state.lastError);
  const quality = useAudioStore((state) => state.syncQuality);
  const rttMs = useAudioStore((state) => state.rttMs);
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <Panel title="Santé" right={`GEN ${generation}`}>
      <p className="glow text-[11px] tracking-wider tabular-nums">
        &gt; {total} CONNEXIONS · SYNC {quality.toUpperCase()} · RTT {Math.round(rttMs)}ms · FILE{" "}
        {controller?.pendingMessages() ?? 0}
      </p>
      {lastError ? (
        <p className="mt-1 text-[11px]" style={{ color: "var(--color-phosphor-amber)" }}>
          ⚠ {lastError.code} — {lastError.message}
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Space, arrows, 1/2 (§6.2). Bound on the window rather than on a focused
 * element so they work wherever the pointer happens to be — except while
 * typing in a field, where space means space.
 */
function useMaestroShortcuts(
  controller: ReturnType<typeof useSessionController>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!controller || !enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      const state = useSessionStore.getState();
      const transport = state.timeline.active;
      const step = event.shiftKey ? 5 : 1;

      switch (event.key) {
        case " ":
          event.preventDefault();
          controller.setTransport({
            state: transport.state === "playing" ? "stopped" : "playing",
          });
          return;
        case "ArrowLeft":
          event.preventDefault();
          controller.setTransport({ bpm: clampBpm(transport.anchor.bpm - step) });
          return;
        case "ArrowRight":
          event.preventDefault();
          controller.setTransport({ bpm: clampBpm(transport.anchor.bpm + step) });
          return;
        case "1":
        case "2": {
          const solo = Number(event.key);
          for (const group of state.groups) {
            const muted = effectiveParameter(state.params, "mute", group.id) === true;
            const shouldMute = group.id !== solo;
            // Pressing the same key again lifts the solo rather than latching it.
            const next = muted && shouldMute ? false : shouldMute;
            controller.setParameter("mute", next, targetGroup(group.id));
          }
          return;
        }
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, enabled]);
}
