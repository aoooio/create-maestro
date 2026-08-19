"use client";

/**
 * Where the maestro token lives, and — more to the point — where it does not.
 *
 * The server hands out a link of the form `/maestro/{id}#token=…`. A fragment
 * never reaches a server, which is why it is the right place to put a secret
 * in a URL; but it stays in the address bar and in the browser's history,
 * which is the wrong place to leave one on a stage in front of an audience.
 * So the page takes it out of the fragment, keeps it in `sessionStorage` (this
 * tab only, gone when it closes), and rewrites the URL.
 */

const PREFIX = "maestro-token:";

export function rememberMaestroToken(sessionId: string, token: string): void {
  try {
    sessionStorage.setItem(PREFIX + sessionId, token);
  } catch {
    // Private mode, or storage disabled: the token stays in memory for this
    // navigation and the console will ask again on reload.
  }
}

export function recallMaestroToken(sessionId: string): string | null {
  try {
    return sessionStorage.getItem(PREFIX + sessionId);
  } catch {
    return null;
  }
}

export function forgetMaestroToken(sessionId: string): void {
  try {
    sessionStorage.removeItem(PREFIX + sessionId);
  } catch {
    // Nothing to do: there was nowhere to forget it from.
  }
}

/**
 * The token in force for a session, from storage or from the fragment of the
 * current URL. This is a pure read — it moves nothing — so a component can
 * call it during render and get the right answer on the very first frame.
 */
export function readMaestroToken(sessionId: string): string | null {
  if (typeof window === "undefined") return null;
  const stored = recallMaestroToken(sessionId);
  if (stored) return stored;
  return tokenInFragment(window.location.hash);
}

/**
 * Moves a token out of the URL and into this tab's storage, replacing the
 * history entry so it leaves neither the address bar nor the back stack. The
 * mutation lives apart from the read above, so the read stays safe to do
 * during render.
 */
export function persistTokenFromFragment(sessionId: string): void {
  if (typeof window === "undefined") return;
  const token = tokenInFragment(window.location.hash);
  if (!token) return;
  rememberMaestroToken(sessionId, token);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

function tokenInFragment(hash: string): string | null {
  const match = /[#&]token=([^&]+)/.exec(hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
