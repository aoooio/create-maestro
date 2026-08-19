"use client";

/**
 * The musician's screen, in the three states of §6.3: the entry gate, the
 * loading bar, and the stage.
 *
 * The gate is not decoration. A browser only lets an `AudioContext` start
 * inside a user gesture, and the clock burst has to settle before the first
 * note is planned — so "Rejoindre l'orchestre" is the moment both of those
 * become possible, and everything before it is a promise not yet kept.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useCapabilities, useSessionController, useWakeLock } from "@/application/hooks/useSession";
import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { groupBadge, groupSkin } from "@/domain/group";
import { performUrl } from "@/infrastructure/ws/client";
import { wsBaseUrl } from "@/infrastructure/config";
import { CrtScreen } from "@/ui/shared/CrtScreen";
import { Cursor, Meter } from "@/ui/shared/Panel";
import { OfflineBanner, SyncBadge } from "@/ui/shared/SyncBadge";

import { PadZone } from "./PadZone";
import { ParamPad } from "./ParamPad";
import { WireframeStage } from "./WireframeStage";

const MAX_NAME = 24;

export function PerformStage({ sessionId }: { sessionId: string }) {
  useCapabilities();
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);

  if (!joined) {
    return <EntryGate name={name} onName={setName} onJoin={() => setJoined(true)} />;
  }
  return <Stage sessionId={sessionId} name={name.trim().slice(0, MAX_NAME)} />;
}

function EntryGate({
  name,
  onName,
  onJoin,
}: {
  name: string;
  onName: (value: string) => void;
  onJoin: () => void;
}) {
  const hasWebAudio = useAudioStore((state) => state.hasWebAudio);

  return (
    <CrtScreen>
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6">
        <div>
          <h1 className="glow-strong text-2xl tracking-[0.3em]">◆ MAESTRO</h1>
          <p className="mt-2 text-xs leading-5 text-dim">
            Vous rejoignez l’orchestre. Votre téléphone jouera une couche synchronisée avec
            toute la salle.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onJoin();
          }}
          className="space-y-6"
        >
          <label className="block">
            <span className="mb-2 block text-[10px] tracking-[0.25em] text-dim">
              PSEUDO (facultatif)
            </span>
            <span className="flex items-center border border-current px-3">
              <input
                value={name}
                onChange={(event) => onName(event.target.value.slice(0, MAX_NAME))}
                maxLength={MAX_NAME}
                autoComplete="off"
                spellCheck={false}
                className="glow w-full bg-transparent py-3 text-base tracking-widest outline-none"
              />
              {name.length === 0 ? <Cursor /> : null}
            </span>
          </label>

          <button
            type="submit"
            // The gesture that creates and resumes the AudioContext.
            className="glow-strong w-full border border-current px-4 py-5 text-sm tracking-[0.25em] uppercase transition-colors hover:bg-phosphor hover:text-screen-deep"
          >
            ▶ rejoindre l’orchestre
          </button>
        </form>

        {!hasWebAudio ? (
          <p className="text-xs" style={{ color: "var(--color-phosphor-amber)" }}>
            ⚠ Web Audio indisponible sur ce navigateur — vous entrerez en mode spectateur.
          </p>
        ) : null}
        <p className="text-[11px] text-dimmer">
          Montez le son et désactivez le mode silencieux. L’écran restera allumé.
        </p>
      </main>
    </CrtScreen>
  );
}

function Stage({ sessionId, name }: { sessionId: string; name: string }) {
  const controller = useSessionController({
    url: performUrl(wsBaseUrl(), sessionId, name),
    role: "musician",
  });

  const stage = useAudioStore((state) => state.stage);
  const progress = useAudioStore((state) => state.progress);
  const failure = useAudioStore((state) => state.failure);
  const localParam = useAudioStore((state) => state.localParam);
  const groupId = useSessionStore((state) => state.groupId);
  const groupLabel = useSessionStore((state) => state.groupLabel);
  const started = useRef(false);

  useWakeLock(stage === "ready");

  // The gesture already happened (the join button); start as soon as the
  // controller exists, which is the first moment there is anything to start.
  useEffect(() => {
    if (!controller || started.current) return;
    started.current = true;
    void controller.startAudio();
  }, [controller]);

  const onParam = useCallback(
    (value: number) => controller?.setLocalParam(value),
    [controller],
  );
  const onTrigger = useCallback(
    (intensity: number) => controller?.sendTrigger("pad", intensity),
    [controller],
  );

  const skin = groupSkin(groupId);

  if (stage !== "ready") {
    return (
      <CrtScreen>
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-6">
          <p className="glow text-sm tracking-[0.25em]">
            {groupId ? groupBadge(groupId, groupLabel) : "> attribution du groupe…"}
          </p>
          {failure ? (
            <p role="alert" className="text-sm" style={{ color: "var(--color-phosphor-amber)" }}>
              ⚠ {failure}
            </p>
          ) : (
            <>
              <Meter value={progress} />
              <p className="text-xs text-dim">
                &gt; {stage === "loading" ? "chargement des voix" : "ouverture du contexte audio"}
              </p>
              <p className="text-xs text-dimmer">&gt; synchronisation de l’horloge…</p>
            </>
          )}
          <SyncBadge compact />
        </main>
      </CrtScreen>
    );
  }

  return (
    <CrtScreen bare>
      <WireframeStage controller={controller} color={skin.color} />

      <div className="relative z-10 flex min-h-dvh flex-col">
        <OfflineBanner />
        <header className="px-4 pt-4">
          <p className="glow text-sm tracking-[0.2em]" style={{ color: skin.cssVar }}>
            {groupBadge(groupId, groupLabel)}
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-4 p-4">
          <PadZone color={skin.color} onTrigger={onTrigger} />
          <ParamPad value={localParam} color={skin.color} onChange={onParam} />
        </div>

        <footer className="px-4 pb-4">
          <SyncBadge compact />
        </footer>
      </div>
    </CrtScreen>
  );
}
