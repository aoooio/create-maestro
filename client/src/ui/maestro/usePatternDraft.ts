"use client";

/**
 * Optimistic edits on a step grid, reconciled on `generation`.
 *
 * The rule is small and easy to get subtly wrong, which is why it lives here
 * rather than in each sequencer that needs it: a locally edited grid stands
 * only until the server echoes that track back with a newer generation, at
 * which point the server's word replaces it outright — no merge, and so
 * nothing to reconcile incorrectly (§4.4).
 *
 * The map of drafts is pruned on every edit rather than on a timer: without
 * that it would grow for the length of a set, one entry per track ever
 * touched.
 */

import { useCallback, useState } from "react";

import { useSessionStore } from "@/application/store/sessionStore";
import type { Pattern, Step, TrackId } from "@/domain/types";

/** A grid edited locally, and the generation it was edited against. */
interface Draft {
  steps: Step[];
  basedOnGeneration: number;
}

export interface PatternDraft {
  /**
   * The grid to display for a track: the local draft while it is still ahead
   * of the server, the server's own steps otherwise.
   */
  resolve(trackId: TrackId, pattern: Pattern | undefined): readonly Step[] | null;
  /** Records a local edit and returns it; the caller sends it on. */
  commit(trackId: TrackId, steps: readonly Step[]): void;
}

export function usePatternDraft(): PatternDraft {
  const patterns = useSessionStore((state) => state.patterns);
  const [drafts, setDrafts] = useState<Map<TrackId, Draft>>(new Map());

  const resolve = useCallback(
    (trackId: TrackId, pattern: Pattern | undefined) => {
      const draft = drafts.get(trackId);
      const live = draft && (pattern?.generation ?? 0) <= draft.basedOnGeneration;
      return live ? draft.steps : (pattern?.steps ?? null);
    },
    [drafts],
  );

  const commit = useCallback(
    (trackId: TrackId, steps: readonly Step[]) => {
      setDrafts((current) => {
        const pruned = new Map<TrackId, Draft>();
        // Drop the drafts the server has already answered, so the map does not
        // grow for the length of a set.
        for (const [id, draft] of current) {
          if ((patterns.get(id)?.generation ?? 0) <= draft.basedOnGeneration) pruned.set(id, draft);
        }
        return pruned.set(trackId, {
          steps: [...steps],
          basedOnGeneration: patterns.get(trackId)?.generation ?? 0,
        });
      });
    },
    [patterns],
  );

  return { resolve, commit };
}
