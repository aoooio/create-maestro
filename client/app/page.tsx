"use client";

/**
 * The way in, for both kinds of user: create a session and take the console,
 * or type the short code and join the orchestra.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { rememberMaestroToken } from "@/application/maestroToken";
import { createSession, describeError, resolveJoinCode } from "@/infrastructure/api/sessions";
import { CrtScreen } from "@/ui/shared/CrtScreen";
import { Cursor } from "@/ui/shared/Panel";

const BOOT_LINES = [
  "MAESTRO SYSTEM · PROTOCOLE v1",
  "EXPÉRIENCE MUSICALE PARTICIPATIVE TEMPS RÉEL",
  "",
  "> horloge partagée ............ prête",
  "> moteur audio ................ prêt",
  "> registres ........... GROUPE 1 · GROUPE 2",
];

export default function LandingPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const booted = useBootSequence(BOOT_LINES.length);

  async function onCreate() {
    setBusy("create");
    setError(null);
    try {
      const session = await createSession();
      // The console reads it from here; it never goes in the URL of this tab.
      rememberMaestroToken(session.sessionId, session.maestroToken);
      router.push(`/maestro/${session.sessionId}`);
    } catch (failure) {
      setError(describeError(failure));
      setBusy(null);
    }
  }

  async function onJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("code") ?? code);
    const trimmed = typed.trim().toUpperCase();
    if (trimmed.length === 0) {
      setError("entrez le code affiché sur l’écran du maestro");
      return;
    }
    setBusy("join");
    setError(null);
    try {
      const resolved = await resolveJoinCode(trimmed);
      router.push(`/perform/${resolved.sessionId}`);
    } catch (failure) {
      setError(describeError(failure));
      setBusy(null);
    }
  }

  return (
    <CrtScreen>
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-8 px-6 py-12">
        <pre className="glow text-[11px] leading-5 sm:text-xs" aria-label="Maestro">
          {String.raw`
 ███▄ ▄███▓ ▄▄▄       ▓█████   ██████ ▄▄▄█████▓ ██▀███   ▒█████
▓██▒▀█▀ ██▒▒████▄     ▓█   ▀ ▒██    ▒ ▓  ██▒ ▓▒▓██ ▒ ██▒▒██▒  ██▒
▓██    ▓██░▒██  ▀█▄   ▒███   ░ ▓██▄   ▒ ▓██░ ▒░▓██ ░▄█ ▒▒██░  ██▒
▒██    ▒██ ░██▄▄▄▄██  ▒▓█  ▄   ▒   ██▒░ ▓██▓ ░ ▒██▀▀█▄  ▒██   ██░
▒██▒   ░██▒ ▓█   ▓██▒ ░▒████▒▒██████▒▒  ▒██▒ ░ ░██▓ ▒██▒░ ████▓▒░
`}
        </pre>

        <div className="space-y-1 text-xs sm:text-sm">
          {BOOT_LINES.slice(0, booted).map((line, index) => (
            <p key={line || index} className="animate-boot text-dim">
              {line || " "}
            </p>
          ))}
        </div>

        <div className="space-y-6 border-t border-dimmer pt-6">
          <div>
            <p className="mb-2 text-xs tracking-[0.2em] text-dim">[1] MAESTRO</p>
            <button
              type="button"
              onClick={onCreate}
              disabled={busy !== null}
              className="glow w-full border border-current px-4 py-3 text-left text-sm tracking-widest uppercase transition-colors hover:bg-phosphor hover:text-screen-deep disabled:opacity-40 sm:text-base"
            >
              {busy === "create" ? "> création…" : "> créer une session"}
            </button>
          </div>

          <form onSubmit={onJoin}>
            <label htmlFor="join-code" className="mb-2 block text-xs tracking-[0.2em] text-dim">
              [2] MUSICIEN · CODE DE SESSION
            </label>
            <div className="flex gap-2">
              <div className="flex flex-1 items-center border border-current px-3">
                <input
                  id="join-code"
                  name="code"
                  type="text"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                  enterKeyHint="go"
                  maxLength={12}
                  placeholder="MZQ4"
                  className="glow w-full bg-transparent py-3 text-lg tracking-[0.4em] uppercase outline-none placeholder:text-dimmer"
                />
                {code.length === 0 ? <Cursor /> : null}
              </div>
              <button
                type="submit"
                disabled={busy !== null}
                className="glow border border-current px-5 text-sm tracking-widest uppercase transition-colors hover:bg-phosphor hover:text-screen-deep disabled:opacity-40"
              >
                {busy === "join" ? "…" : "OK"}
              </button>
            </div>
          </form>
        </div>

        {error ? (
          <p role="alert" className="glow text-sm" style={{ color: "var(--color-phosphor-amber)" }}>
            ⚠ {error}
          </p>
        ) : null}
      </main>
    </CrtScreen>
  );
}

/** Prints the boot lines one after another, like a machine coming up. */
function useBootSequence(total: number): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= total) return;
    const timer = setTimeout(() => setShown((value) => value + 1), 90);
    return () => clearTimeout(timer);
  }, [shown, total]);

  return shown;
}
