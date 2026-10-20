import type { LiveMatch } from "@tournament-admin/shared";

export const EVENT = { id: 1, name: "Spring Invitational", active_session_id: 1, game_plugin_name: "game" };
export const SESSIONS = [{ id: 1, label: "Saturday", timezone: "UTC" }];
export const DIVISIONS = [{ id: 4, name: "Division 1" }];
export const FIELD_SETS = [{ id: 10, session_id: 1, name: "Main Fields", division_id: null, purpose: "teamwork" }];
export const FIELDS = [
  { id: 1, field_set_id: 10, name: "Field 1" },
  { id: 2, field_set_id: 10, name: "Field 2" },
];
export const TEAMS = [
  { id: 1, number: "101A", name: "Rockets", division_id: 4, city: "Springfield", state: "IL", country: null },
  { id: 2, number: "102B", name: "Gears", division_id: 4, city: null, state: null, country: null },
  { id: 3, number: "103C", name: "Bolts", division_id: 4, city: "Shelbyville", state: null, country: null },
  { id: 4, number: "104D", name: "Sparks", division_id: 4, city: null, state: null, country: "Canada" },
];
export const HEAD_TO_HEAD = { game_model: "head_to_head", autonomous_seconds: 15, driver_seconds: 105, alliance_count: 2, teams_per_alliance: 2 };
export const COOPERATIVE = { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60, alliance_count: 2, teams_per_alliance: 1 };

let nextId = 100;
export function match(overrides: Partial<LiveMatch> = {}): LiveMatch {
  const id = overrides.id ?? nextId++;
  return {
    id,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: id,
    label: `Q${id}`,
    field_id: 1,
    scheduled_time: null,
    status: "scheduled",
    phase: "not_started",
    phase_deadline: null,
    paused: false,
    remaining_seconds_at_pause: null,
    is_finals: false,
    bracket_matchup_id: null,
    bracket_alliance_id: null,
    alliances: [
      { id: id * 10 + 1, station: "red", team_ids: [1, 2] },
      { id: id * 10 + 2, station: "blue", team_ids: [3, 4] },
    ],
    ...overrides,
  };
}

export function me(group: Record<string, unknown> | null, sessionId: number | null = 1) {
  return { device: { id: 7, name: "Big TV" }, session_id: sessionId, group };
}

export function audienceGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 50, session_id: 1, kind: "audience", name: "Main Fields", field_set_id: 10, field_id: null, division_id: null,
    screen: "logo", screen_settings: {}, rotation: null, play_sounds: false,
    field_set: { queued_match_id: null, timeout_deadline: null }, ...overrides,
  };
}

export function fieldGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 51, session_id: 1, kind: "field", name: "Field 1", field_set_id: 10, field_id: 1, division_id: null,
    screen: null, screen_settings: {}, rotation: null, play_sounds: false,
    field_set: { queued_match_id: null, timeout_deadline: null }, ...overrides,
  };
}

export function pitGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 52, session_id: 1, kind: "pit", name: "Pit TVs", field_set_id: null, field_id: null, division_id: null,
    screen: "logo", screen_settings: {}, rotation: null, play_sounds: false, field_set: null, ...overrides,
  };
}

/** The reads every screen shares, keyed by exact request path. */
export function baseRoutes(): Record<string, unknown> {
  return {
    "/api/event": EVENT,
    "/api/sessions": SESSIONS,
    "/api/divisions": DIVISIONS,
    "/api/teams": TEAMS,
    "/api/event/match-format": HEAD_TO_HEAD,
    "/api/field-sets?session_id=1": FIELD_SETS,
    "/api/fields?session_id=1": FIELDS,
    "/api/matches?session_id=1": [],
    "/api/scores?session_id=1": [],
    "/api/rankings?session_id=1": [],
    "/api/rankings?session_id=1&division_id=4": [],
  };
}
