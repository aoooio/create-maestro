"use client";

/**
 * The address the server prints on a session's `joinUrl`: a short code, not an
 * id. It resolves and forwards — this is the link that goes on the poster.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { describeError, resolveJoinCode } from "@/infrastructure/api/sessions";
import { CrtScreen } from "@/ui/shared/CrtScreen";

export default function JoinByCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveJoinCode(code)
      .then((resolved) => {
        if (!cancelled) router.replace(`/perform/${resolved.sessionId}`);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(describeError(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [code, router]);

  return (
    <CrtScreen>
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="glow text-sm tracking-[0.3em]">SESSION {code.toUpperCase()}</p>
        {error ? (
          <>
            <p role="alert" className="glow text-sm" style={{ color: "var(--color-phosphor-amber)" }}>
              ⚠ {error}
            </p>
            <Link
              href="/"
              className="glow border border-current px-4 py-2 text-xs tracking-widest uppercase"
            >
              retour
            </Link>
          </>
        ) : (
          <p className="text-dim text-sm">&gt; résolution du code…</p>
        )}
      </main>
    </CrtScreen>
  );
}
