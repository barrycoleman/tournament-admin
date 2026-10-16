import { createContext, useCallback, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { inDivision, type AllianceScore, type DisplayGroupState, type FieldSetLive, type LiveMatch } from "@tournament-admin/shared";
import { getJson } from "../deviceApi";

export interface DisplayMeGroup extends DisplayGroupState {
  field_set: FieldSetLive | null;
}
export interface DisplayMe {
  device: { id: number; name: string };
  session_id: number | null;
  group: DisplayMeGroup | null;
}
export interface EventInfo {
  id: number;
  name: string;
  active_session_id: number | null;
  game_plugin_name: string | null;
}
export type GameModel = "head_to_head" | "cooperative_score";
export interface MatchFormat {
  game_model: GameModel;
  autonomous_seconds: number;
  driver_seconds: number;
  alliance_count: number;
  teams_per_alliance: number;
}
export interface Team {
  id: number;
  number: string;
  name: string;
  division_id: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
}
export interface Division {
  id: number;
  name: string;
}
export interface Field {
  id: number;
  field_set_id: number;
  name: string;
}
export interface FieldSet {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
}
export interface SessionInfo {
  id: number;
  label: string;
  timezone: string | null;
}
export interface Ranking {
  team_id: number;
  division_id: number | null;
  rank: number;
  win_points: number;
  strength_of_schedule: number;
  average_score: number;
  matches_played: number;
}
export interface SkillsSettings {
  enabled: boolean;
  attempts: Record<string, number>;
  types: { key: string; label: string }[];
}
export interface SkillsRankingRow {
  rank: number;
  team_id: number;
  score: number;
  attempts: number[];
}
export interface SkillsAttempt {
  id: number;
  team_id: number;
  skills_type: string;
  score: number;
  recorded_at: string;
}
export interface FinalsBracket {
  id: number;
  session_id: number;
  division_id: number | null;
  field_set_id: number;
  format: "single_elimination" | "score_chase";
  bracket_size: number;
  status: string;
  alliances: { id: number; seed: number; team_ids: number[]; unavailable: boolean }[];
  runs: { match_id: number; bracket_alliance_id: number | null; status: string; score: number | null }[];
  results: { bracket_alliance_id: number; score: number; rank: number }[];
  matchups: {
    id: number;
    round_number: number;
    position: number;
    matchup_number: number | null;
    alliance_a_id: number | null;
    alliance_b_id: number | null;
    winner_alliance_id: number | null;
  }[];
}
export interface ScoresheetFieldInfo {
  name: string;
  label: string;
  data_type: string;
  options: (string | number)[] | null;
}

/** Returns the device's current access token (it is renewed every half hour). */
export const TokenContext = createContext<() => string>(() => "");

export const paths = {
  me: "/api/displays/me",
  event: "/api/event",
  matchFormat: "/api/event/match-format",
  scoresheet: "/api/event/scoresheet-schema",
  divisions: "/api/divisions",
  teams: "/api/teams",
  sessions: "/api/sessions",
  skillsSettings: "/api/skills/settings",
  matches: (sessionId: number) => `/api/matches?session_id=${sessionId}`,
  scores: (sessionId: number) => `/api/scores?session_id=${sessionId}`,
  fields: (sessionId: number) => `/api/fields?session_id=${sessionId}`,
  fieldSets: (sessionId: number) => `/api/field-sets?session_id=${sessionId}`,
  rankings: (sessionId: number, divisionId: number | null) =>
    divisionId === null
      ? `/api/rankings?session_id=${sessionId}`
      : `/api/rankings?session_id=${sessionId}&division_id=${divisionId}`,
  skillsRankings: (sessionId: number, tab: string) =>
    `/api/skills/rankings?tab=${encodeURIComponent(tab)}&session_id=${sessionId}`,
  skillsAttempts: (sessionId: number) => `/api/sessions/${sessionId}/skills/attempts`,
  finals: (sessionId: number, divisionId: number | null) =>
    divisionId === null
      ? `/api/finals?session_id=${sessionId}`
      : `/api/finals?session_id=${sessionId}&division_id=${divisionId}`,
};

export function useFetchJson() {
  const getToken = useContext(TokenContext);
  return useCallback(<T,>(path: string) => getJson<T>(path, getToken()), [getToken]);
}

function useJson<T>(queryKey: readonly unknown[], path: string) {
  const fetchJson = useFetchJson();
  return useQuery({ queryKey, queryFn: () => fetchJson<T>(path) });
}

export const useMe = () => useJson<DisplayMe>(["me"], paths.me);
export const useEventInfo = () => useJson<EventInfo>(["event"], paths.event);
export const useMatchFormat = () => useJson<MatchFormat>(["matchFormat"], paths.matchFormat);
export const useScoresheetSchema = () => useJson<ScoresheetFieldInfo[]>(["scoresheetSchema"], paths.scoresheet);
export const useDivisions = () => useJson<Division[]>(["divisions"], paths.divisions);
export const useTeams = () => useJson<Team[]>(["teams"], paths.teams);
export const useSessions = () => useJson<SessionInfo[]>(["sessions"], paths.sessions);
export const useSkillsSettings = () => useJson<SkillsSettings>(["skillsSettings"], paths.skillsSettings);
export const useMatches = (sessionId: number) => useJson<LiveMatch[]>(["matches", sessionId], paths.matches(sessionId));
export const useScores = (sessionId: number) => useJson<AllianceScore[]>(["scores", sessionId], paths.scores(sessionId));
export const useFields = (sessionId: number) => useJson<Field[]>(["fields", sessionId], paths.fields(sessionId));
export const useFieldSets = (sessionId: number) => useJson<FieldSet[]>(["fieldSets", sessionId], paths.fieldSets(sessionId));
export const useRankings = (sessionId: number, divisionId: number | null) =>
  useJson<Ranking[]>(["rankings", sessionId, divisionId], paths.rankings(sessionId, divisionId));
export const useSkillsRankings = (sessionId: number, tab: string) =>
  useJson<SkillsRankingRow[]>(["skillsRankings", sessionId, tab], paths.skillsRankings(sessionId, tab));
export const useSkillsAttempts = (sessionId: number) =>
  useJson<SkillsAttempt[]>(["skillsAttempts", sessionId], paths.skillsAttempts(sessionId));
export const useFinals = (sessionId: number, divisionId: number | null) =>
  useJson<FinalsBracket[]>(["finals", sessionId, divisionId], paths.finals(sessionId, divisionId));

export function useTeamsById(): Map<number, Team> | undefined {
  const teams = useTeams();
  return teams.data ? new Map(teams.data.map((team) => [team.id, team])) : undefined;
}

export function useSessionTimeZone(sessionId: number): string | null {
  const sessions = useSessions();
  return sessions.data?.find((s) => s.id === sessionId)?.timezone ?? null;
}

/** The event's only division, or null when it has several. */
export function useSoleDivisionId(): number | null {
  const divisions = useDivisions();
  return divisions.data?.length === 1 ? divisions.data[0].id : null;
}

/** Rankings for a division, plus the rows that carry no division when the
 * screen has no division or the division is the event's only one (a
 * single-division event's); each team once, in rank order. */
export function useMergedRankings(sessionId: number, divisionId: number | null): Ranking[] | undefined {
  const divisions = useDivisions();
  const sole = useSoleDivisionId();
  const own = useRankings(sessionId, divisionId);
  const unscoped = useRankings(sessionId, null);
  const withUnscoped = divisionId === null || divisionId === sole;
  if (!divisions.data || !own.data || (withUnscoped && !unscoped.data)) return undefined;
  const seen = new Set<number>();
  const rows: Ranking[] = [];
  for (const row of [...own.data, ...(withUnscoped ? unscoped.data! : [])]) {
    if (!seen.has(row.team_id)) {
      seen.add(row.team_id);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.rank - b.rank);
}

/** Team id -> current session rank in the division. */
export function useRanks(sessionId: number, divisionId: number | null): Map<number, number> | undefined {
  const rows = useMergedRankings(sessionId, divisionId);
  return rows ? new Map(rows.map((row) => [row.team_id, row.rank])) : undefined;
}

/** The match filter for a screen's division (see the shared inDivision rule). */
export function useDivisionFilter(divisionId: number | null): (row: { division_id: number | null }) => boolean {
  const sole = useSoleDivisionId();
  return inDivision(divisionId, sole);
}

/** The division's newest finals bracket (no-division brackets count only for
 * a screen with no division or the event's only division); null when none
 * exists yet, undefined while loading. */
export function useNewestFinals(sessionId: number, divisionId: number | null): FinalsBracket | null | undefined {
  const divisions = useDivisions();
  const sole = useSoleDivisionId();
  const own = useFinals(sessionId, divisionId ?? sole);
  const unscoped = useFinals(sessionId, null);
  const withUnscoped = divisionId === null || divisionId === sole;
  if (!divisions.data || !own.data || (withUnscoped && !unscoped.data)) return undefined;
  const byId = new Map([...own.data, ...(withUnscoped ? unscoped.data! : [])].map((bracket) => [bracket.id, bracket]));
  return [...byId.values()].sort((a, b) => b.id - a.id)[0] ?? null;
}
