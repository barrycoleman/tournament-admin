import type { ApiRequestOptions } from "../api-client";
import type { RealtimeEvent } from "../realtime";
import type { ScoresheetValues } from "../scoresheet";

/** Who last changed one draft item, and when (server time). */
export interface ItemMeta {
  device_name: string;
  at: string;
}

/** One team's No-show / DQ flags. Drafts list flagged teams only. */
export interface TeamFlags {
  team_id: number;
  no_show: boolean;
  dq: boolean;
}

export type TeamFlag = "no_show" | "dq";

/** One alliance's draft, as GET /api/matches/{id}/draft lists it and the PATCH returns it. */
export interface AllianceDraft {
  alliance_id: number;
  data: ScoresheetValues;
  teams: TeamFlags[];
  item_meta: Record<string, ItemMeta>;
  /** 0 while the alliance has no draft; +1 per accepted change. */
  version: number;
  /** The plugin's score of the draft so far (0 when it can't be calculated yet). */
  score: number;
}

export interface MatchDraft {
  match_id: number;
  submitted: boolean;
  alliances: AllianceDraft[];
}

/** The `score_draft_changed` payload: one alliance's full draft. */
export interface ScoreDraftChanged extends AllianceDraft {
  match_id: number;
}

/** A Submit refused by the plugin's rules: one entry per alliance (null for a skills run). */
export interface SubmitViolation {
  alliance_id: number | null;
  messages: string[];
}

export type SkillsPhase = "ready" | "running" | "ended";

export interface SkillsSetTimer {
  field_set_id: number;
  skills_type: string | null;
  phase: SkillsPhase;
  deadline: string | null;
  paused: boolean;
  remaining_seconds: number | null;
  run_seconds: number | null;
}

/** A skills run; its timer fields are the effective ones (the set's while it follows the set). */
export interface SkillsRun {
  id: number;
  field_id: number;
  field_set_id: number;
  team_id: number;
  team_number: string;
  team_name: string;
  skills_type: string;
  data: ScoresheetValues;
  item_meta: Record<string, ItemMeta>;
  version: number;
  score: number;
  follows_set: boolean;
  phase: SkillsPhase;
  deadline: string | null;
  paused: boolean;
  remaining_seconds: number | null;
}

export interface SkillsSetField {
  field_id: number;
  name: string;
  run: SkillsRun | null;
}

/** GET /api/field-sets/{id}/skills. */
export interface SkillsSet {
  timer: SkillsSetTimer;
  fields: SkillsSetField[];
}

/** The live events a scoring page listens to, from whichever socket its app holds. */
export interface ScoringSocket {
  connected: boolean;
  /** Must be stable across renders; returns the unsubscribe function. */
  subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
}

/** The app's request function (the admin's `apiRequest`, or the device app's own). */
export type ScoringRequest = <T>(path: string, options?: ApiRequestOptions) => Promise<T>;

export type MatchClockAction = "start" | "start-driver" | "pause" | "resume" | "end" | "reset";
export type SkillsTimerAction = "start" | "pause" | "resume" | "end" | "reset";

/** The part of GET /api/event/match-format the scoring page needs. */
export interface ScoringMatchFormat {
  game_model: string;
  autonomous_seconds: number;
  driver_seconds: number;
}

/** The server's exact details, which change what the page shows. */
export const SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it.";
export const NOT_PLAYED_SCORE_DETAIL = "This match was not played; reopen qualification to score it.";

/** How long an item another device changed stays highlighted. */
export const FLASH_MS = 2000;
/** How often a change that failed on the network is retried. */
export const RETRY_MS = 3000;
