"use client";

/**
 * The console's address. Its only job before rendering is to get hold of the
 * maestro token — from the fragment of the link the server printed, or from
 * this tab's storage — and to take it out of the URL (see `maestroToken.ts`).
 */

import Link from "next/link";
import { use, useEffect, useState, useSyncExternalStore } from "react";

import { persistTokenFromFragment, readMaestroToken } from "@/application/maestroToken";
import { CrtScreen } from "@/ui/shared/CrtScreen";
import { MaestroConsole } from "@/ui/maestro/MaestroConsole";

export default function MaestroPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  // Read on the client's first render — the server has neither the storage nor
  // the fragment, so it renders the waiting state and hydration fills it in.
  const [token] = useState<string | null>(() => readMaestroToken(sessionId));
  const hydrated = useHydrated();

  useEffect(() => {
    persistTokenFromFragment(sessionId);
  }, [sessionId]);

  if (!hydrated) {
    return (
      <CrtScreen>
        <main className="flex min-h-dvh items-center justify-center">
          <p className="text-dim text-sm">&gt; ouverture de la console…</p>
        </main>
      </CrtScreen>
    );
  }

  if (token === null) {
    return (
      <CrtScreen>
        <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="glow text-sm tracking-[0.2em]" style={{ color: "var(--color-phosphor-amber)" }}>
            ⚠ AUCUN JETON MAESTRO
          </p>
          <p className="text-dim text-sm">
            La console n’est accessible que depuis le lien de création de la session. Le jeton
            n’est jamais rediffusé : il faut ouvrir le lien d’origine, ou créer une nouvelle
            session.
          </p>
          <Link
            href="/"
            className="glow border border-current px-4 py-2 text-xs tracking-widest uppercase"
          >
            retour
          </Link>
        </main>
      </CrtScreen>
    );
  }

  return <MaestroConsole sessionId={sessionId} token={token} />;
}

/** True only once the client has taken over. The server can see neither the
 * fragment nor the tab's storage, so it must not render the verdict on the
 * token — it would be "missing" every time. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}
