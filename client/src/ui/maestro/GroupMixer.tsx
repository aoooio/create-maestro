"use client";

/**
 * One strip per register. Muting a group is a `param.set` aimed at that group
 * (§6.2); soloing is the same message aimed at everyone else, because the
 * protocol has no notion of solo — and should not: the server stores state,
 * the console has opinions.
 */

import type { SessionController } from "@/application/session";
import { useSessionStore } from "@/application/store/sessionStore";
import { effectiveParameter } from "@/domain/parameter";
import { groupBadge, groupSkin, targetGroup } from "@/domain/group";
import { Panel } from "@/ui/shared/Panel";

const FADER_STEPS = 12;

export function GroupMixer({ controller }: { controller: SessionController | null }) {
  const groups = useSessionStore((state) => state.groups);
  const params = useSessionStore((state) => state.params);

  function solo(group: number) {
    for (const other of groups) {
      controller?.setParameter("mute", other.id !== group, targetGroup(other.id));
    }
  }

  return (
    <Panel title="Mixage des groupes">
      <div className="flex gap-4">
        {groups.map((group) => {
          const skin = groupSkin(group.id);
          const gain = Number(effectiveParameter(params, "gain", group.id));
          const cutoff = Number(effectiveParameter(params, "cutoff", group.id));
          const muted = effectiveParameter(params, "mute", group.id) === true;

          return (
            <div
              key={group.id}
              className="flex-1 border border-dimmer p-3"
              style={{ color: skin.cssVar, borderColor: skin.cssVar }}
            >
              <p className="glow mb-2 text-[11px] tracking-[0.15em]">
                {groupBadge(group.id, group.label)}
              </p>
              <p className="mb-3 text-[11px] text-dim tabular-nums">
                {group.count} musicien{group.count > 1 ? "s" : ""}
              </p>

              <Fader
                label="GAIN"
                value={muted ? 0 : gain}
                onChange={(value) => controller?.setParameter("gain", value, targetGroup(group.id))}
              />
              <Fader
                label="CUTOFF"
                value={cutoff}
                onChange={(value) => controller?.setParameter("cutoff", value, targetGroup(group.id))}
              />

              <div className="mt-3 flex gap-1">
                <button
                  type="button"
                  onClick={() => controller?.setParameter("mute", !muted, targetGroup(group.id))}
                  aria-pressed={muted}
                  className={`flex-1 border border-current py-1 text-[11px] tracking-widest ${muted ? "glow-strong bg-current/20" : "text-dim"}`}
                >
                  MUTE
                </button>
                <button
                  type="button"
                  onClick={() => solo(group.id)}
                  className="flex-1 border border-current py-1 text-[11px] tracking-widest text-dim hover:text-current"
                >
                  SOLO
                </button>
              </div>
            </div>
          );
        })}
        {groups.length === 0 ? <p className="text-dim text-sm">&gt; en attente de l’état…</p> : null}
      </div>
    </Panel>
  );
}

/** A fader drawn in blocks. It is a range input underneath, so it keeps
 * keyboard control and screen-reader semantics for free. */
function Fader({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const filled = Math.round(value * FADER_STEPS);
  return (
    <label className="mb-2 block">
      <span className="mb-1 flex justify-between text-[10px] tracking-[0.2em] text-dim">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(value * 100)}</span>
      </span>
      {/* The blocks are the fader; the range input sits invisibly on top of
          them, so dragging lands where it looks like it should and keyboard
          and screen-reader support come for free. */}
      <span className="relative block h-6">
        <span aria-hidden className="glow absolute inset-0 flex items-center text-sm leading-none">
          {"▓".repeat(filled)}
          <span className="text-dimmer">{"░".repeat(FADER_STEPS - filled)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={label}
        />
      </span>
    </label>
  );
}
