import { useQuery, useQueryClient } from "@tanstack/react-query";
import { paths, useFetchJson } from "./api";
import { useLiveEvents } from "./events";

export interface LiveAllianceScore {
  alliance_id: number;
  score: number;
}
export interface LiveMatchScore {
  match_id: number;
  alliances: LiveAllianceScore[];
}
export interface BreakdownItem {
  label: string;
  /** Null for an item nobody entered (the server sends defaults, but a display never trusts that). */
  value: number | string | boolean | null;
}
export interface LiveSkillsScore {
  field_id: number;
  /** Sent while the run's timer runs and the session allows live scores. */
  score?: number | null;
  /** Sent once the timer has ended, until the run is submitted or discarded. */
  breakdown?: BreakdownItem[] | null;
}
export interface LiveScores {
  matches: LiveMatchScore[];
  skills: LiveSkillsScore[];
}

const EMPTY: LiveScores = { matches: [], skills: [] };

/** Folds one `live_score` event into what the display holds: totals replace a
 * match's or field's entry, `cleared` removes it, anything else is ignored. */
export function applyLiveScore(current: LiveScores, data: unknown): LiveScores {
  if (typeof data !== "object" || data === null) return current;
  const event = data as {
    match_id?: unknown;
    field_id?: unknown;
    cleared?: unknown;
    alliances?: LiveAllianceScore[];
    score?: number | null;
    breakdown?: BreakdownItem[] | null;
  };
  if (typeof event.match_id === "number") {
    const others = current.matches.filter((entry) => entry.match_id !== event.match_id);
    return {
      ...current,
      matches: event.cleared ? others : [...others, { match_id: event.match_id, alliances: event.alliances ?? [] }],
    };
  }
  if (typeof event.field_id === "number") {
    const others = current.skills.filter((entry) => entry.field_id !== event.field_id);
    return {
      ...current,
      skills: event.cleared
        ? others
        : [...others, { field_id: event.field_id, score: event.score ?? null, breakdown: event.breakdown ?? null }],
    };
  }
  return current;
}

/** What the server lets this field set's displays show right now: fetched
 * once (and again on reconnect, like every read), then kept by live_score. */
export function useLiveScores(fieldSetId: number | null): LiveScores {
  const fetchJson = useFetchJson();
  const queryClient = useQueryClient();
  const queryKey = ["liveScores", fieldSetId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchJson<LiveScores>(paths.liveScores(fieldSetId as number)),
    enabled: fieldSetId !== null,
  });
  useLiveEvents(["live_score"], (event) => {
    if (fieldSetId === null) return;
    queryClient.setQueryData<LiveScores>(queryKey, (current) => applyLiveScore(current ?? EMPTY, event.data));
  });
  return query.data ?? EMPTY;
}
