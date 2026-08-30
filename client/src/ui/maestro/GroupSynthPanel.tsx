"use client";

/**
 * The timbre of each group's layer, laid out the way a small synth is: what
 * the note is made of on the left, how it arrives and leaves in the middle,
 * where it sits on the right.
 *
 * The preset buttons are a shorthand, not a mode. Pressing one writes the six
 * parameters of that group and nothing else — there is no "current preset" on
 * the wire, exactly as there is no solo in the protocol (see `GroupMixer`).
 * The console highlights whichever preset the live values happen to spell,
 * and stops highlighting anything the moment a fader moves, which is the
 * honest reading of what the room is playing.
 */

import type { SessionController } from "@/application/session";
import { useSessionStore } from "@/application/store/sessionStore";
import { groupBadge, groupSkin, targetGroup } from "@/domain/group";
import { PARAMETER_REGISTRY, effectiveParameter } from "@/domain/parameter";
import {
  SYNTH_PRESETS,
  SYNTH_PRESET_NAMES,
  WAVES,
  matchingPreset,
  type SynthKey,
  type SynthPresetName,
} from "@/domain/synth";
import type { GroupId } from "@/domain/types";
import { Fader } from "@/ui/shared/Fader";
import { Panel } from "@/ui/shared/Panel";

/** The four continuous controls, in the order they act on a note. */
const FADER_KEYS: readonly SynthKey[] = [
  "synthAttack",
  "synthRelease",
  "synthBrightness",
  "synthSpread",
];

const OCTAVES = [-2, -1, 0, 1, 2] as const;

export function GroupSynthPanel({ controller }: { controller: SessionController | null }) {
  const groups = useSessionStore((state) => state.groups);

  return (
    <Panel title="Synthés de groupe">
      {groups.length === 0 ? (
        <p className="text-dim text-sm">&gt; en attente de l’état…</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((group) => (
            <GroupVoice
              key={group.id}
              group={group.id}
              label={group.label}
              controller={controller}
            />
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] text-dimmer">
        Chaque groupe synthétise sa couche note par note : ces réglages partent vers les
        téléphones du groupe, pas vers la salle entière.
      </p>
    </Panel>
  );
}

function GroupVoice({
  group,
  label,
  controller,
}: {
  group: GroupId;
  label: string;
  controller: SessionController | null;
}) {
  const params = useSessionStore((state) => state.params);
  const skin = groupSkin(group);
  const target = targetGroup(group);

  const read = (key: SynthKey) => Number(effectiveParameter(params, key, group));
  const set = (key: SynthKey, value: number) => controller?.setParameter(key, value, target);
  const active = matchingPreset(read);

  /** A preset is six writes, not one: the server stores values, and a sound
   * recalled from half of them is not the sound. */
  function recall(name: SynthPresetName) {
    const preset = SYNTH_PRESETS[name];
    for (const key of Object.keys(preset) as SynthKey[]) set(key, preset[key]);
  }

  const wave = Math.round(read("synthWave"));
  const octave = Math.round(read("synthOctave"));

  return (
    <div className="border border-dimmer p-3" style={{ color: skin.cssVar, borderColor: skin.cssVar }}>
      <p className="glow mb-2 text-[11px] tracking-[0.15em]">{groupBadge(group, label)}</p>

      <div className="mb-3 flex flex-wrap gap-1">
        {SYNTH_PRESET_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => recall(name)}
            aria-pressed={active === name}
            className={`flex-1 border border-current px-2 py-1 text-[10px] tracking-widest ${
              active === name ? "glow-strong bg-current/20" : "text-dim hover:text-current"
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <Segmented
        label="WAVE"
        options={WAVES.map((name, index) => ({ label: name, value: index }))}
        value={wave}
        describe={(name) => `Forme d’onde ${name} pour le groupe ${group}`}
        onChange={(value) => set("synthWave", value)}
      />

      <div className="mt-2 grid grid-cols-2 gap-x-4">
        {FADER_KEYS.map((key) => (
          <Fader
            key={key}
            label={PARAMETER_REGISTRY[key].label}
            // Several panels carry a fader called ATTACK or SPREAD; on screen
            // the frame says which group owns this one, and a screen reader
            // has to be told.
            ariaLabel={`Groupe ${group} ${PARAMETER_REGISTRY[key].label}`}
            value={read(key)}
            onChange={(value) => set(key, value)}
          />
        ))}
      </div>

      <Segmented
        label="OCTAVE"
        options={OCTAVES.map((value) => ({
          label: value > 0 ? `+${value}` : String(value),
          value,
        }))}
        value={octave}
        describe={(name) => `Octave ${name} pour le groupe ${group}`}
        onChange={(value) => set("synthOctave", value)}
      />
    </div>
  );
}

/**
 * A row of exclusive buttons, for the two settings that are enumerations
 * rather than travel. A fader cannot say "the third waveform" — it can only
 * say "three fifths of the way to it".
 */
function Segmented({
  label,
  options,
  value,
  describe,
  onChange,
}: {
  label: string;
  options: readonly { label: string; value: number }[];
  value: number;
  describe: (label: string) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-[10px] tracking-[0.2em] text-dim">{label}</span>
      <div className="flex gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            aria-label={describe(option.label)}
            className={`flex-1 border border-current px-1 py-0.5 text-[10px] tabular-nums ${
              value === option.value ? "glow-strong bg-current/20" : "text-dim hover:text-current"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
