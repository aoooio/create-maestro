"use client";

/**
 * The one-line status of everything a performer needs to trust: the socket and
 * the clock.
 *
 * It never leans on colour alone (§7): each state has its own word and its own
 * glyph, so it works on a monochrome screen, for a colour-blind reader, and
 * for a screen reader — which gets the whole thing as a live region.
 */

import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { SYNC_QUALITY_LABEL, type SyncQuality } from "@/infrastructure/clock/clockSync";
import type { ConnectionState } from "@/infrastructure/ws/client";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "● HORS LIGNE",
  connecting: "◐ CONNEXION",
  open: "● EN LIGNE",
  reconnecting: "◌ RECONNEXION",
  closed: "○ DÉCONNECTÉ",
};

const QUALITY_GLYPH: Record<SyncQuality, string> = {
  unknown: "···",
  good: "▮▮▮",
  fair: "▮▮·",
  poor: "▮··",
};

export function SyncBadge({ compact = false }: { compact?: boolean }) {
  const connection = useSessionStore((state) => state.connection);
  const attempt = useSessionStore((state) => state.reconnectAttempt);
  const quality = useAudioStore((state) => state.syncQuality);
  const rttMs = useAudioStore((state) => state.rttMs);

  const degraded = connection !== "open" || quality === "poor";
  const color = degraded ? "var(--color-phosphor-amber)" : undefined;

  return (
    <output
      aria-live="polite"
      className="flex items-center gap-3 text-[11px] tracking-wider tabular-nums"
      style={color ? { color } : undefined}
    >
      <span className="glow">
        {CONNECTION_LABEL[connection]}
        {connection === "reconnecting" && attempt > 0 ? ` ${attempt}` : ""}
      </span>
      <span className="glow">
        <span aria-hidden>{QUALITY_GLYPH[quality]} </span>
        {SYNC_QUALITY_LABEL[quality]}
      </span>
      {!compact && rttMs > 0 ? <span className="text-dim">RTT {Math.round(rttMs)}ms</span> : null}
    </output>
  );
}

/** The banner shown while the socket is down. The sound keeps playing on the
 * last known transport (§6.5) — saying so is the difference between "broken"
 * and "carry on". */
export function OfflineBanner() {
  const connection = useSessionStore((state) => state.connection);
  const fatal = useSessionStore((state) => state.fatal);

  if (fatal) {
    return (
      <div
        role="alert"
        className="glow border-b px-4 py-2 text-xs tracking-wider"
        style={{ color: "var(--color-phosphor-amber)", borderColor: "var(--color-phosphor-amber)" }}
      >
        ⚠ {fatal.reason === "protocol_version" ? "CLIENT TROP ANCIEN — RAFRAÎCHISSEZ LA PAGE" : fatal.message.toUpperCase()}
      </div>
    );
  }

  if (connection === "open" || connection === "idle" || connection === "connecting") return null;

  return (
    <div
      role="status"
      className="glow border-b px-4 py-2 text-xs tracking-wider"
      style={{ color: "var(--color-phosphor-amber)", borderColor: "var(--color-phosphor-amber)" }}
    >
      ◌ HORS LIGNE — le son continue sur le dernier transport connu
    </div>
  );
}
