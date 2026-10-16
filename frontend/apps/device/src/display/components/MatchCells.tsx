import type { AllianceScore, LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";
import { allianceGroups, groupScore, type BandStation } from "../logic/alliances";

export function TeamNumbers({ teamIds, teams, station }: { teamIds: number[]; teams: Map<number, Team>; station: BandStation }) {
  return (
    <span className={`team-numbers team-numbers--${station}`}>
      {teamIds.map((id) => (
        <span key={id}>{teams.get(id)?.number ?? ""}</span>
      ))}
    </span>
  );
}

/** "9–3" for a head-to-head match, the shared score for a cooperative one. */
export function scoreText(match: LiveMatch, scores: AllianceScore[], gameModel: GameModel): string {
  const byAlliance = new Map(scores.filter((s) => s.match_id === match.id).map((s) => [s.alliance_id, s.score]));
  const totals = allianceGroups(match, gameModel).map((group) => groupScore(group, byAlliance) ?? "–");
  return totals.join("–");
}
