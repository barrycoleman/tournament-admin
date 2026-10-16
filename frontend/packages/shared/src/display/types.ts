/** Shapes the display screens and the admin's Match Control read from the server. */
export type GroupKind = "audience" | "field" | "pit";

export interface LiveAlliance {
  id: number;
  station: string;
  team_ids: number[];
}

/** A match as GET /api/matches returns it, including its live timing. */
export interface LiveMatch {
  id: number;
  session_id: number;
  division_id: number | null;
  round_type: string;
  match_number: number;
  label: string;
  field_id: number | null;
  scheduled_time: string | null;
  status: string;
  phase: string;
  phase_deadline: string | null;
  paused: boolean;
  remaining_seconds_at_pause: number | null;
  is_finals: boolean;
  bracket_matchup_id?: number | null;
  bracket_alliance_id?: number | null;
  alliances: LiveAlliance[];
}

/** One alliance's saved score, as GET /api/scores returns it. */
export interface AllianceScore {
  match_id: number;
  alliance_id: number;
  score: number;
  data: Record<string, number | boolean | string>;
  teams: { team_id: number; no_show: boolean; dq: boolean }[];
  saved_at: string | null;
}

export interface ScreenSettings {
  count?: number;
  scope?: "field_set" | "division";
}

export interface RotationEntry {
  screen: string;
  settings: ScreenSettings;
  seconds: number;
}

export interface DisplayGroupState {
  id: number;
  session_id: number;
  kind: GroupKind;
  name: string;
  field_set_id: number | null;
  field_id: number | null;
  division_id: number | null;
  screen: string | null;
  screen_settings: ScreenSettings;
  rotation: RotationEntry[] | null;
  play_sounds: boolean;
}

export interface FieldSetLive {
  queued_match_id: number | null;
  timeout_deadline: string | null;
}
