"use client";

/**
 * The second sequencer: what each group's phones play, written by hand.
 *
 * It is the drum machine's twin — same frame, same cells, same playhead moved
 * by `transform` without a React render (§6.2) — turned on its side. Where a
 * drum lane asks *when*, a strip has to answer *when and which note*, and the
 * grid is the answer: rows are pitches, so a melody is a shape rather than a
 * column of numbers to read one at a time.
 *
 * The rows are a minor pentatonic (`domain/scale.ts`), not a chromatic roll.
 * That is a deliberate loss of freedom: the maestro is writing, on a dark
 * stage, a line fifty phones will play back at once, and there is no way to
 * stop and fix a wrong interval. A grid that cannot express one is worth more
 * here than a grid that can express everything.
 *
 * A strip is monophonic. One note per step keeps the shape legible at a
 * glance and makes every edit a single, obvious gesture — which is the whole
 * point of a second sequencer that has to be usable during a set.
 */

import { useMemo, useRef } from "react";

import type { SessionController } from "@/application/session";
import { useTransportPosition } from "@/application/hooks/useTransportPosition";
import { useAudioStore } from "@/application/store/audioStore";
import { useSessionStore } from "@/application/store/sessionStore";
import { ACCENT_THRESHOLD } from "@/application/voicing";
import { groupBadge, groupSkin } from "@/domain/group";
import { clampNote, noteName } from "@/domain/note";
import { effectiveParameter } from "@/domain/parameter";
import { emptyGrid, resizeGrid } from "@/domain/pattern";
import { STRIP_ROWS, groupTrackId, noteForRow, rowForNote } from "@/domain/scale";
import type { GroupId, Step } from "@/domain/types";
import { Panel } from "@/ui/shared/Panel";

import { CELL_WIDTH_REM, playheadOpacity, playheadTransform } from "./grid";
import { usePatternDraft } from "./usePatternDraft";

/** Same two levels as the drum machine, so an accent means one thing on the
 * console. */
const ACCENT_VELOCITY = 1;
const PLAIN_VELOCITY = 0.6;

/** Strip lengths the console offers, in steps. A one-bar loop comes round very
 * fast under a crowd; four bars is as long as the protocol will carry
 * (`MAX_STEPS`). */
const LENGTHS = [16, 32, 64] as const;
const DEFAULT_LENGTH = 16;

export function NoteStripSequencer({ controller }: { controller: SessionController | null }) {
  const groups = useSessionStore((state) => state.groups);

  return (
    <Panel title="Bandes de notes">
      {groups.length === 0 ? (
        <p className="text-dim text-sm">&gt; en attente de l’état…</p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <GroupStrip key={group.id} group={group.id} label={group.label} controller={controller} />
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] text-dimmer">
        Clic pour poser une note · glisser verticalement pour la hauteur · Maj+clic pour
        l’accent · MONITOR écoute la couche du groupe sur cette console, sans rien changer
        dans la salle
      </p>
    </Panel>
  );
}

/**
 * One group's strip: its toolbar, its grid and its own playhead.
 *
 * Each strip drives its playhead from its own animation frame rather than
 * sharing one with its neighbour. The loops are cheap — they read the store
 * imperatively and write one `transform` — and the alternative is a registry
 * of elements owned by the parent, which buys nothing and costs the strip its
 * self-containment.
 */
function GroupStrip({
  group,
  label,
  controller,
}: {
  group: GroupId;
  label: string;
  controller: SessionController | null;
}) {
  const patterns = useSessionStore((state) => state.patterns);
  const params = useSessionStore((state) => state.params);
  const timeline = useSessionStore((state) => state.timeline);
  const monitored = useAudioStore((state) => state.monitorGroups.has(group));
  const draft = usePatternDraft();

  const trackId = groupTrackId(group);
  const skin = groupSkin(group);
  const transport = timeline.active;
  const stepsPerBar = transport.beatsPerBar * transport.stepsPerBeat;
  // The row labels show what will sound, so they read through the same ROOT
  // the voicing applies.
  const transpose = Math.round(Number(effectiveParameter(params, "bassRoot", 0)));

  const playheadRef = useRef<HTMLDivElement>(null);
  /** The column a vertical drag started in; a drag moves a pitch, it does not
   * paint across the bar. */
  const dragColumn = useRef<number | null>(null);

  const steps = useMemo(() => {
    const resolved = draft.resolve(trackId, patterns.get(trackId));
    // Unlike a drum lane, a strip is *not* resized to the bar: its length is
    // its loop, and folding it onto the bar is exactly what `stepAtIndex`
    // exists to avoid.
    return resolved ? [...resolved] : emptyGrid(DEFAULT_LENGTH);
  }, [draft, patterns, trackId]);

  useTransportPosition(controller, (frame) => {
    const head = playheadRef.current;
    if (!head) return;
    // Absolute step index folded onto the strip: a two-bar strip is only
    // halfway through when the bar counter turns over.
    const absolute = frame.bar * stepsPerBar + frame.stepInBar;
    head.style.transform = playheadTransform(
      ((absolute % steps.length) + steps.length) % steps.length,
    );
    head.style.opacity = playheadOpacity(frame.playing, frame.beatPhase);
  });

  /** The single write path: every edit goes through it, so they all share one
   * optimistic draft and the server's word replaces all of them the same way. */
  function write(next: readonly Step[]) {
    if (!controller) return;
    draft.commit(trackId, next);
    controller.setPattern(trackId, next);
  }

  function edit(column: number, change: (step: Step) => Step) {
    write(steps.map((step, index) => (index === column ? change(step) : step)));
  }

  /** Places the note of a row, or lifts it when it is already the one there. */
  function toggleCell(row: number, column: number, accented: boolean) {
    const step = steps[column]!;
    const occupied = step.on && rowForNote(group, step.note) === row;
    if (occupied) {
      // The pitch is deliberately kept: a step switched off and back on must
      // return the note the maestro dialled in, not a default.
      edit(column, (current) => ({ ...current, on: false, velocity: 0 }));
      return;
    }
    edit(column, () => ({
      on: true,
      velocity: accented ? ACCENT_VELOCITY : PLAIN_VELOCITY,
      note: noteForRow(group, row),
    }));
  }

  function moveTo(row: number, column: number) {
    const step = steps[column]!;
    if (!step.on || rowForNote(group, step.note) === row) return;
    edit(column, (current) => ({ ...current, note: noteForRow(group, row) }));
  }

  function toggleAccent(column: number) {
    edit(column, (step) => ({
      ...step,
      velocity: step.velocity >= ACCENT_THRESHOLD ? PLAIN_VELOCITY : ACCENT_VELOCITY,
    }));
  }

  return (
    <div className="border border-dimmer p-2" style={{ borderColor: skin.cssVar }}>
      <StripToolbar
        group={group}
        badge={groupBadge(group, label)}
        color={skin.cssVar}
        length={steps.length}
        monitored={monitored}
        onLength={(length) => write(resizeGrid(steps, length))}
        onMonitor={() => controller?.toggleMonitor(group)}
        onClear={() => write(emptyGrid(steps.length))}
      />

      <div className="overflow-x-auto" style={{ color: skin.cssVar }}>
        {/* `min-content` so the scroll container measures the grid, not the
            panel: without it a 64-step strip is squeezed instead of scrolled. */}
        <div className="relative w-min">
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 left-16 bg-current/20"
            style={{ width: `${CELL_WIDTH_REM}rem`, willChange: "transform" }}
            ref={playheadRef}
          />
          <StripGrid
            group={group}
            steps={steps}
            transpose={transpose}
            stepsPerBar={stepsPerBar}
            stepsPerBeat={transport.stepsPerBeat}
            onCell={toggleCell}
            onAccent={toggleAccent}
            onDragStart={(column) => {
              dragColumn.current = column;
            }}
            onDragEnter={(row, column) => {
              if (dragColumn.current === column) moveTo(row, column);
            }}
            onDragEnd={() => {
              dragColumn.current = null;
            }}
          />
        </div>
      </div>
    </div>
  );
}

function StripToolbar({
  group,
  badge,
  color,
  length,
  monitored,
  onLength,
  onMonitor,
  onClear,
}: {
  group: GroupId;
  badge: string;
  color: string;
  length: number;
  monitored: boolean;
  onLength: (length: number) => void;
  onMonitor: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2" style={{ color }}>
      <p className="glow text-[11px] tracking-[0.15em]">{badge}</p>
      <div className="flex items-center gap-1">
        {LENGTHS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onLength(option)}
            aria-pressed={length === option}
            aria-label={`Groupe ${group} longueur ${option} pas`}
            className={`border border-current px-2 py-0.5 text-[10px] tabular-nums ${
              length === option ? "glow-strong bg-current/20" : "text-dim"
            }`}
          >
            {option}
          </button>
        ))}
        <button
          type="button"
          onClick={onMonitor}
          aria-pressed={monitored}
          aria-label={`Écouter le groupe ${group} sur cette console`}
          className={`ml-2 border border-current px-2 py-0.5 text-[10px] tracking-widest ${
            monitored ? "glow-strong bg-current/20" : "text-dim"
          }`}
        >
          MONITOR
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label={`Effacer la bande du groupe ${group}`}
          className="border border-current px-2 py-0.5 text-[10px] tracking-widest text-dim hover:text-current"
        >
          CLEAR
        </button>
      </div>
    </div>
  );
}

/**
 * The grid itself: pitches down, steps across. It draws and reports gestures;
 * every decision about what an edit means belongs to `GroupStrip`.
 *
 * Rows run high to low, the way a stave does — so `STRIP_ROWS - 1 - offset`
 * is the row a line stands for.
 */
function StripGrid({
  group,
  steps,
  transpose,
  stepsPerBar,
  stepsPerBeat,
  onCell,
  onAccent,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: {
  group: GroupId;
  steps: readonly Step[];
  transpose: number;
  stepsPerBar: number;
  stepsPerBeat: number;
  onCell: (row: number, column: number, accented: boolean) => void;
  onAccent: (column: number) => void;
  onDragStart: (column: number) => void;
  onDragEnter: (row: number, column: number) => void;
  onDragEnd: () => void;
}) {
  return (
    <div onPointerUp={onDragEnd} onPointerLeave={onDragEnd}>
      <div className="flex gap-2 pl-16 text-[10px] text-dimmer tabular-nums">
        {steps.map((_, index) => (
          <span key={index} className="w-6 text-center">
            {index % stepsPerBar === 0
              ? `|${index / stepsPerBar + 1}`
              : index % stepsPerBeat === 0
                ? index / stepsPerBeat + 1
                : "·"}
          </span>
        ))}
      </div>

      {Array.from({ length: STRIP_ROWS }, (_, offset) => {
        const row = STRIP_ROWS - 1 - offset;
        const pitch = noteName(clampNote(noteForRow(group, row) + transpose));
        return (
          <div key={row} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right text-[10px] text-dim tabular-nums">
              {pitch}
            </span>
            {steps.map((step, column) => {
              const active = step.on && rowForNote(group, step.note) === row;
              const accented = active && step.velocity >= ACCENT_THRESHOLD;
              return (
                <button
                  key={column}
                  type="button"
                  onPointerDown={() => onDragStart(column)}
                  onPointerEnter={() => onDragEnter(row, column)}
                  onClick={(event) =>
                    event.shiftKey && active ? onAccent(column) : onCell(row, column, event.shiftKey)
                  }
                  aria-pressed={active}
                  aria-label={cellLabel(group, column, pitch, active, accented)}
                  className={`h-5 w-6 shrink-0 text-center text-sm leading-5 transition-none ${
                    active ? "glow-strong" : "text-dimmer hover:text-dim"
                  } ${column % stepsPerBar === 0 ? "border-l border-dim" : column % stepsPerBeat === 0 ? "border-l border-dimmer" : ""}`}
                >
                  {active ? (accented ? "█" : "▓") : "░"}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What a screen reader is told about one cell. The group and the pitch are
 * always spoken: several strips are on screen at once, and without both the
 * grid is a field of identically named buttons.
 */
function cellLabel(
  group: GroupId,
  column: number,
  pitch: string,
  active: boolean,
  accented: boolean,
): string {
  const where = `GROUPE ${group} pas ${column + 1} ${pitch}`;
  if (!active) return `${where}, vide`;
  return `${where}, actif${accented ? ", accentué" : ""}`;
}
