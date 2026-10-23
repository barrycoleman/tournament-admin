import { countCheckedInTeams, countUsableFields } from "../schedule/readiness";
import type {
  FieldRead,
  FieldSetRead,
  MatchFormat,
  MatchRead,
  ParticipationRead,
  SessionRead,
  TeamSummary,
} from "../types";

export type EventSetupKey = "gamePlugin" | "teams" | "session";

export function checkEventSetup(input: {
  gamePluginSelected: boolean;
  teamCount: number;
  sessionCount: number;
}): { key: EventSetupKey; ok: boolean }[] {
  return [
    { key: "gamePlugin", ok: input.gamePluginSelected },
    { key: "teams", ok: input.teamCount > 0 },
    { key: "session", ok: input.sessionCount > 0 },
  ];
}

export type SessionReadinessKey =
  | "timezone"
  | "fields"
  | "playingTimes"
  | "teams"
  | "schedule"
  | "active"
  | "displays";

export interface SessionReadinessItem {
  key: SessionReadinessKey;
  ok: boolean;
  blocking: boolean;
}

export function checkSessionReadiness(input: {
  session: SessionRead;
  activeSessionId: number | null;
  divisions: { id: number }[];
  teams: TeamSummary[];
  participants: ParticipationRead[];
  fieldSets: FieldSetRead[];
  fields: FieldRead[];
  windowCount: number;
  matches: MatchRead[];
  matchFormat: MatchFormat | null;
  displayCount: number;
}): SessionReadinessItem[] {
  // A single-division event uses `null`, as the schedule route does.
  const divisionIds: (number | null)[] =
    input.divisions.length > 1 ? input.divisions.map((d) => d.id) : [null];
  const teamsNeeded = input.matchFormat
    ? input.matchFormat.teams_per_alliance * input.matchFormat.alliance_count
    : 0;

  const fieldsOk = divisionIds.every(
    (id) => countUsableFields(input.fieldSets, input.fields, id) > 0
  );
  const teamsOk = divisionIds.every(
    (id) =>
      teamsNeeded > 0 &&
      countCheckedInTeams(input.teams, input.participants, id) >= teamsNeeded
  );
  const scheduleOk = divisionIds.every((id) =>
    input.matches.some((m) => !m.is_finals && m.division_id === id)
  );

  return [
    { key: "timezone", ok: input.session.timezone !== null, blocking: true },
    { key: "fields", ok: fieldsOk, blocking: true },
    { key: "playingTimes", ok: input.windowCount > 0, blocking: true },
    { key: "teams", ok: teamsOk, blocking: true },
    { key: "schedule", ok: scheduleOk, blocking: true },
    { key: "active", ok: input.activeSessionId === input.session.id, blocking: true },
    { key: "displays", ok: input.displayCount > 0, blocking: false },
  ];
}

export type NextSessionStep = "setup" | "planMatches" | "makeActive" | "matchControl";

export function nextSessionStep(items: SessionReadinessItem[]): NextSessionStep {
  const ok = (key: SessionReadinessKey) => items.find((i) => i.key === key)?.ok ?? false;
  if (!ok("timezone") || !ok("fields")) return "setup";
  if (!ok("playingTimes") || !ok("teams") || !ok("schedule")) return "planMatches";
  if (!ok("active")) return "makeActive";
  return "matchControl";
}
