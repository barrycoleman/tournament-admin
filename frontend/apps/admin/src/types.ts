export interface EventRead {
  id: number;
  name: string;
  active_session_id: number | null;
  game_plugin_name: string | null;
  created_at: string;
}

export interface PluginSummary {
  name: string;
  version: string;
  display_name: string;
}

export interface ServerInfo {
  port: number;
  addresses: string[];
}

export interface Division {
  id: number;
  event_id: number;
  name: string;
  target_team_count: number | null;
}

export interface SessionRead {
  id: number;
  event_id: number;
  label: string;
  session_date: string | null;
  timezone: string | null;
}

export interface FieldSetRead {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
}

export interface FieldRead {
  id: number;
  field_set_id: number;
  name: string;
}

export interface AllianceRead {
  id: number;
  station: string;
  team_ids: number[];
}

export interface MatchRead {
  id: number;
  session_id: number;
  division_id: number | null;
  round_type: string;
  match_number: number;
  label: string;
  field_id: number | null;
  time_slot: number | null;
  scheduled_time: string | null;
  status: string;
  is_finals: boolean;
  alliances: AllianceRead[];
}

export interface MatchFormat {
  round_types: string[];
  teams_per_alliance: number;
  alliance_count: number;
  match_duration_seconds: number;
  default_cycle_time_seconds: number | null;
}

export interface PlayingWindowRead {
  date: string;
  start_time: string;
  end_time: string;
  start_utc: string | null;
  end_utc: string | null;
}

export interface ScheduledRound {
  round_type: string;
  target_matches_per_team: number | null;
  cycle_time_seconds: number | null;
  match_count: number;
  scored_count: number;
  first_start: string | null;
  last_end: string | null;
  locked: boolean;
  outside_playing_windows: boolean;
}

export interface ScheduleRounds {
  rounds: ScheduledRound[];
  session_last_cycle_time_seconds: number | null;
}

export interface PlanRoundResult {
  round_type: string;
  schedule_generation_id: number | null;
  match_count: number;
  slot_count: number;
  first_start: string | null;
  /** Null when the round doesn't fully fit. */
  last_end: string | null;
}

export interface PlanOverflow {
  unplaced_slot_count: number;
  unplaced_match_count: number;
  over_by_seconds: number;
  suggested_cycle_time_seconds: number | null;
  suggested_last_window_end: string | null;
}

export interface PlanResponse {
  fits: boolean;
  rounds: PlanRoundResult[];
  overflow: PlanOverflow | null;
}

export interface TeamSummary {
  id: number;
  number: string;
  name: string;
  division_id: number | null;
}

export interface ParticipationRead {
  id: number;
  session_id: number;
  team_id: number;
  checked_in: boolean;
}

export interface ResolvedTimeBlock {
  date: string;
  start_time: string;
  end_time: string | null;
  cycle_time_seconds: number;
  time_slot_count: number;
}

export interface PhaseResult {
  round_type: string;
  schedule_generation_id: number | null;
  match_count: number;
}

export interface ScheduleGenerateResponse {
  schedule_generation_id: number | null;
  match_count: number;
  resolved_time_blocks: ResolvedTimeBlock[];
  cycle_time_warning: string | null;
  phase_results: PhaseResult[] | null;
}
