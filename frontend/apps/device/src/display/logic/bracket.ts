import type { TFunction } from "i18next";
import type { AllianceScore, LiveMatch } from "@tournament-admin/shared";
import type { FinalsBracket } from "../api";

function sameTeams(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Each matchup's game wins so far: a game's alliance belongs to the bracket
 * alliance with the same teams; a tie counts for neither. */
export function seriesWins(
  bracket: FinalsBracket,
  matches: LiveMatch[],
  scores: AllianceScore[]
): Map<number, { a: number; b: number }> {
  const teamsOf = new Map(bracket.alliances.map((alliance) => [alliance.id, alliance.team_ids]));
  const byAlliance = new Map(scores.map((s) => [s.alliance_id, s.score]));
  const wins = new Map<number, { a: number; b: number }>();
  for (const matchup of bracket.matchups) {
    const tally = { a: 0, b: 0 };
    const aTeams = matchup.alliance_a_id !== null ? teamsOf.get(matchup.alliance_a_id) ?? [] : [];
    for (const game of matches) {
      if (game.bracket_matchup_id !== matchup.id || game.alliances.length !== 2) continue;
      const [first, second] = game.alliances;
      const s1 = byAlliance.get(first.id);
      const s2 = byAlliance.get(second.id);
      if (s1 === undefined || s2 === undefined || s1 === s2) continue;
      const winner = s1 > s2 ? first : second;
      if (sameTeams(winner.team_ids, aTeams)) tally.a += 1;
      else tally.b += 1;
    }
    wins.set(matchup.id, tally);
  }
  return wins;
}

/** "Final", "Semifinals", "Quarterfinals", else "Round N". */
export function roundName(t: TFunction, roundNumber: number, roundCount: number): string {
  const fromEnd = roundCount - roundNumber;
  if (fromEnd === 0) return t("display.bracket.final");
  if (fromEnd === 1) return t("display.bracket.semifinals");
  if (fromEnd === 2) return t("display.bracket.quarterfinals");
  return t("display.bracket.round", { number: roundNumber });
}
