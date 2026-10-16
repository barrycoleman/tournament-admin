import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";

export type BandStation = "red" | "blue" | "all";

export interface AllianceGroup {
  station: BandStation;
  teamIds: number[];
  allianceIds: number[];
}

/** Red then blue for a head-to-head game; one group with every team for a
 * cooperative game, whose alliances share one outcome. */
export function allianceGroups(match: LiveMatch, gameModel: GameModel): AllianceGroup[] {
  if (gameModel === "cooperative_score") {
    const teamIds = [...new Set(match.alliances.flatMap((a) => a.team_ids))];
    return [{ station: "all", teamIds, allianceIds: match.alliances.map((a) => a.id) }];
  }
  return [...match.alliances]
    .sort((a, b) => (a.station === "blue" ? 1 : 0) - (b.station === "blue" ? 1 : 0))
    .map((a) => ({ station: a.station === "blue" ? "blue" : "red", teamIds: a.team_ids, allianceIds: [a.id] }));
}

/** "City, State, Country", whichever are set. */
export function teamPlace(team: Team | undefined): string {
  if (!team) return "";
  return [team.city, team.state, team.country].filter(Boolean).join(", ");
}

/** A group's score: its alliances' best saved score (a cooperative game's
 * alliances carry the same mirrored score). */
export function groupScore(group: AllianceGroup, scores: Map<number, number>): number | null {
  const values = group.allianceIds.map((id) => scores.get(id)).filter((v): v is number => v !== undefined);
  return values.length ? Math.max(...values) : null;
}
