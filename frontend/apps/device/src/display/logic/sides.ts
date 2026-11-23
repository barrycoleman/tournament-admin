import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";

export type Side = "red" | "blue";
export interface MatchSides {
  red: number[];
  blue: number[];
}
export type ScoreSide = Side | "combined";
export interface ScoreGroup {
  side: ScoreSide;
  allianceIds: number[];
}

/** A finalist pair (a solo alliance) by side: the better ranked team red and
 * the other blue; when any rank is missing, the server's order decides: first
 * red, second blue. */
export function pairSides(teamIds: number[], ranks?: Map<number, number>): MatchSides {
  let ids = teamIds;
  const ranked = ids.map((id) => ranks?.get(id));
  if (ids.length > 1 && ranked.every((r) => r !== undefined)) {
    ids = [...ids].sort((a, b) => ranks!.get(a)! - ranks!.get(b)!);
  }
  return { red: ids.slice(0, 1), blue: ids.slice(1) };
}

/** Which teams stand on which side. A red or blue alliance keeps its side
 * (both game models). A solo alliance (a score-chase run) follows pairSides. */
export function matchSides(match: LiveMatch, ranks?: Map<number, number>): MatchSides {
  const sides: MatchSides = { red: [], blue: [] };
  for (const alliance of match.alliances) {
    if (alliance.station === "red") sides.red.push(...alliance.team_ids);
    else if (alliance.station === "blue") sides.blue.push(...alliance.team_ids);
    else {
      const pair = pairSides(alliance.team_ids, ranks);
      sides.red.push(...pair.red);
      sides.blue.push(...pair.blue);
    }
  }
  return sides;
}

/** Score groups: one per side for a head-to-head match, one combined group for
 * a cooperative match or any match with a solo alliance. */
export function scoreGroups(match: LiveMatch, gameModel: GameModel): ScoreGroup[] {
  const solo = match.alliances.some((a) => a.station !== "red" && a.station !== "blue");
  if (gameModel === "cooperative_score" || solo) {
    return [{ side: "combined", allianceIds: match.alliances.map((a) => a.id) }];
  }
  return [...match.alliances]
    .sort((a, b) => (a.station === "blue" ? 1 : 0) - (b.station === "blue" ? 1 : 0))
    .map((a) => ({ side: a.station === "blue" ? "blue" : "red", allianceIds: [a.id] }));
}

/** A group's score: its alliances' best saved score (a cooperative game's
 * alliances carry the same mirrored score). */
export function groupScore(group: ScoreGroup, scores: Map<number, number>): number | null {
  const values = group.allianceIds.map((id) => scores.get(id)).filter((v): v is number => v !== undefined);
  return values.length ? Math.max(...values) : null;
}

/** The winning side, "tie", or null for a combined score or a missing score. */
export function resultOutcome(groups: ScoreGroup[], scores: Map<number, number>): Side | "tie" | null {
  if (groups.length !== 2) return null;
  const [a, b] = groups.map((g) => groupScore(g, scores));
  if (a === null || b === null) return null;
  if (a === b) return "tie";
  return (a > b ? groups[0].side : groups[1].side) as Side;
}

/** "City, State, Country", whichever are set. */
export function teamPlace(team: Team | undefined): string {
  if (!team) return "";
  return [team.city, team.state, team.country].filter(Boolean).join(", ");
}

/** Teams by side, red then blue, leaving out an empty side. */
export function sideGroups(match: LiveMatch, ranks?: Map<number, number>): { side: Side; teamIds: number[] }[] {
  const sides = matchSides(match, ranks);
  return (["red", "blue"] as const).filter((s) => sides[s].length > 0).map((s) => ({ side: s, teamIds: sides[s] }));
}
