import type { ScoresheetValue } from "../scoresheet";
import type { AllianceDraft, ItemMeta, TeamFlag, TeamFlags } from "./types";

/** The item key a team flag is stored under in `item_meta` (and in the pending map). */
export function teamFlagKey(teamId: number, flag: TeamFlag): string {
  return `team:${teamId}:${flag}`;
}

const TEAM_KEY = /^team:(\d+):(no_show|dq)$/;

/** Parses `team:<id>:<flag>`; null for a scoresheet item. */
export function parseTeamFlagKey(key: string): { teamId: number; flag: TeamFlag } | null {
  const match = TEAM_KEY.exec(key);
  return match ? { teamId: Number(match[1]), flag: match[2] as TeamFlag } : null;
}

/** Anything with draft items: a teamwork alliance draft or a skills run. */
export interface DraftLike {
  data: Record<string, ScoresheetValue>;
  item_meta: Record<string, ItemMeta>;
  teams?: TeamFlags[];
}

/** Every item of a draft as one flat map, team flags included (an unlisted team's flags are false). */
function flatten(draft: DraftLike): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...draft.data };
  for (const team of draft.teams ?? []) {
    flat[teamFlagKey(team.team_id, "no_show")] = team.no_show;
    flat[teamFlagKey(team.team_id, "dq")] = team.dq;
  }
  return flat;
}

function flagValue(draft: DraftLike, key: string): unknown {
  const flat = flatten(draft);
  if (key in flat) return flat[key];
  return parseTeamFlagKey(key) ? false : undefined;
}

/** The draft with the still-unacknowledged local changes laid over it. */
export function withPending<T extends DraftLike>(draft: T, pending: Record<string, unknown>): T {
  const keys = Object.keys(pending);
  if (keys.length === 0) return draft;
  const data = { ...draft.data };
  const teams = new Map((draft.teams ?? []).map((team) => [team.team_id, { ...team }]));
  for (const key of keys) {
    const flag = parseTeamFlagKey(key);
    if (flag === null) {
      data[key] = pending[key] as ScoresheetValue;
      continue;
    }
    const team = teams.get(flag.teamId) ?? { team_id: flag.teamId, no_show: false, dq: false };
    team[flag.flag] = pending[key] === true;
    teams.set(flag.teamId, team);
  }
  const merged = { ...draft, data };
  if (draft.teams === undefined) return merged;
  return {
    ...merged,
    teams: [...teams.values()].filter((team) => team.no_show || team.dq).sort((a, b) => a.team_id - b.team_id),
  };
}

/** The newer of the two drafts (by version), with still-pending local items kept on top. */
export function mergeIncoming(local: AllianceDraft, incoming: AllianceDraft, pending: Record<string, unknown>): AllianceDraft {
  const base = incoming.version > local.version ? incoming : local;
  return withPending(base, pending);
}

/** Item keys whose value differs between the two drafts and that another device changed last. */
export function changedByOthers(prev: DraftLike, next: DraftLike, myDevice: string): string[] {
  const before = flatten(prev);
  const after = flatten(next);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (flagValue(prev, key) === flagValue(next, key)) continue;
    const meta = next.item_meta[key];
    if (meta && meta.device_name !== myDevice) changed.push(key);
  }
  return changed.sort();
}
