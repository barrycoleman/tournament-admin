import type { ScoresheetValues } from "@tournament-admin/shared";

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
  /** A session with a scored match can't be deleted. */
  has_scored_matches: boolean;
  /** When qualification was finalized; null while it is open. */
  qualification_finalized_at: string | null;
  /** Played count -> drops chosen at finalize; {} for head-to-head; null while open. */
  qualification_drops: Record<string, number> | null;
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

export type GameModel = "head_to_head" | "cooperative_score";
export type SessionDropMode = "tiered" | "none" | "lowest";

export interface RankingRead {
  session_id: number | null;
  division_id: number | null;
  team_id: number;
  win_points: number;
  strength_of_schedule: number;
  average_score: number;
  matches_played: number;
  rank: number;
}

export interface RankingSettingsValues {
  session_drop_mode: SessionDropMode;
  session_drop_count: number;
  session_drop_no_show: boolean;
  session_drop_dq: boolean;
  season_keep_best: number | null;
  season_only_session_counted: boolean;
  season_minimum: number;
  season_drop_no_show: boolean;
  season_drop_dq: boolean;
}

export interface RankingSettingsRead extends RankingSettingsValues {
  game_model: GameModel | null;
}

export type QualificationBlockerCode = "no_matches" | "in_progress" | "ended_unscored" | "partially_scored";

export interface QualificationPreview {
  finalized: boolean;
  game_model: GameModel;
  rows: { played: number; teams: number; suggested: number }[];
  unplayed_matches: number;
  blockers: { code: QualificationBlockerCode; count: number }[];
}

export interface SkillsType {
  key: string;
  label: string;
}

export interface SkillsSettingsRead {
  enabled: boolean;
  /** Every plugin type's allowed attempts per session, 3 where unset. */
  attempts: Record<string, number>;
  /** In tie-break priority order; [] before a game plugin is chosen or for a game with no skills. */
  types: SkillsType[];
}

export interface SessionSkillsType extends SkillsType {
  /** The effective allowed attempts in this session. */
  allowed: number;
}

export interface SessionSkillsRead {
  types: SessionSkillsType[];
  /** The session's own attempts, or null when it uses the event setting. */
  override: Record<string, number> | null;
}

export interface SkillsAttemptRead {
  id: number;
  team_id: number;
  skills_type: string;
  /** 1, 2, 3, ... per team and type in the session. */
  number: number;
  score: number;
  data: ScoresheetValues;
  recorded_at: string;
  updated_at: string;
}

export interface SkillsRankingRead {
  rank: number;
  team_id: number;
  score: number;
  /** Best first; for Overall, each type's list in plugin order. */
  attempts: number[];
  session_id: number;
}

export type AwardKind = "judged" | "performance";
export type AwardScope = "event" | "division";
export type AwardSource = "teamwork_ranking" | "finals" | "skills_overall" | "skills_type";
export type AwardBasis = "session" | "season";
export type SlotStatus =
  | "judged_pending"
  | "judged"
  | "resolved"
  | "provisional"
  | "no_result"
  | "overridden"
  | "finalized";

export interface AwardWinnerTeam {
  team_id: number;
  number: string;
  name: string;
  organization: string | null;
}

export interface AwardSlotRead {
  division_id: number | null;
  division_name: string | null;
  status: SlotStatus;
  winners: AwardWinnerTeam[];
  override_reason: string | null;
  note: "unknown_skills_type" | "skills_disabled" | null;
  moved_team_ids: number[];
}

export interface AwardDefinition {
  name: string;
  description: string | null;
  kind: AwardKind;
  scope: AwardScope;
  division_ids: number[];
  source: AwardSource | null;
  skills_type: string | null;
  basis: AwardBasis | null;
  placement: number | null;
}

export interface AwardRead extends AwardDefinition {
  id: number;
  session_id: number;
  position: number;
  slots: AwardSlotRead[];
}

export interface SessionAwardsRead {
  awards_finalized_at: string | null;
  awards: AwardRead[];
}

export interface FinalizeWarning {
  award_id: number;
  award_name: string;
  division_id: number | null;
  division_name: string | null;
  status: SlotStatus;
}

export interface FinalizeRead {
  awards_finalized_at: string | null;
  warnings: FinalizeWarning[];
}

export interface TeamAwardEntry {
  award_id: number;
  award_name: string;
  kind: AwardKind;
  session_id: number;
  session_label: string;
}

export interface TeamAwardHistory {
  team_id: number;
  awards: TeamAwardEntry[];
}
