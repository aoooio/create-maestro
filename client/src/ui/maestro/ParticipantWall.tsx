"use client";

/**
 * Who is in the room, and what they are doing.
 *
 * Triggers arrive as fast as an audience can tap — two hundred phones is two
 * hundred gestures a second at the peak of a set. They are therefore
 * accumulated in a ref and flushed on a timer, so the wall repaints a few
 * times a second instead of a few hundred. Presence itself comes from the
 * store, where the server's counts are authoritative.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSessionStore } from "@/application/store/sessionStore";
import { groupBadge, groupSkin } from "@/domain/group";
import type { TriggerRelay } from "@/infrastructure/ws/codec";
import { Panel } from "@/ui/shared/Panel";

/** Repaint rate of the pulse column. Fast enough to read as live, slow enough
 * to cost nothing. */
const FLUSH_MS = 120;
/** How many rows of the arrival log to keep on screen. */
const LOG_ROWS = 12;

export interface TriggerSink {
  push: (trigger: TriggerRelay) => void;
}

/** Collects triggers outside React and flushes them on a timer. */
export function useTriggerSink(): { sink: TriggerSink; pulses: Map<number, number> } {
  const buffer = useRef(new Map<number, number>());
  const [pulses, setPulses] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    const timer = setInterval(() => {
      if (buffer.current.size === 0) {
        setPulses((current) => (current.size === 0 ? current : new Map()));
        return;
      }
      setPulses(new Map(buffer.current));
      buffer.current = new Map();
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  const push = useCallback((trigger: TriggerRelay) => {
    // Only the loudest gesture per group survives a flush: the wall shows the
    // room's energy, not a transcript of it.
    const current = buffer.current.get(trigger.groupId) ?? 0;
    buffer.current.set(trigger.groupId, Math.max(current, trigger.intensity));
  }, []);

  const sink = useMemo<TriggerSink>(() => ({ push }), [push]);

  return { sink, pulses };
}

export function ParticipantWall({ pulses }: { pulses: Map<number, number> }) {
  const groups = useSessionStore((state) => state.groups);
  const roster = useSessionStore((state) => state.roster);
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <Panel title="Mur des participants" right={`${total} connecté${total > 1 ? "s" : ""}`}>
      <div className="mb-3 space-y-2">
        {groups.map((group) => {
          const skin = groupSkin(group.id);
          const pulse = pulses.get(group.id) ?? 0;
          return (
            <div key={group.id} className="flex items-center gap-3" style={{ color: skin.cssVar }}>
              <span className="glow w-44 shrink-0 text-[11px] tracking-[0.15em]">
                {groupBadge(group.id, group.label)}
              </span>
              <span className="tabular-nums text-xs">{String(group.count).padStart(3, "0")}</span>
              {/* Population as a bar, the current gesture as its brightness. */}
              <span
                aria-hidden
                className="glow flex-1 truncate text-sm leading-none"
                style={{ opacity: 0.3 + pulse * 0.7 }}
              >
                {"▮".repeat(Math.min(48, group.count))}
              </span>
            </div>
          );
        })}
      </div>

      <div className="h-40 overflow-y-auto border-t border-dimmer pt-2 text-[11px] leading-5">
        {roster.length === 0 ? (
          <p className="text-dimmer">&gt; personne n’est encore arrivé</p>
        ) : (
          roster
            .slice(-LOG_ROWS)
            .reverse()
            .map((entry) => (
              <p key={entry.id} className="text-dim" style={{ color: groupSkin(entry.group).cssVar }}>
                <span className="text-dimmer">
                  {new Date(entry.joinedAtMs).toLocaleTimeString("fr-FR", { hour12: false })}{" "}
                </span>
                {/* The maestro belongs to no group; "GROUPE 0" is not a place. */}
                &gt; {entry.name || "anonyme"} → {entry.group === 0 ? "MAESTRO" : `GROUPE ${entry.group}`}
              </p>
            ))
        )}
      </div>
    </Panel>
  );
}
