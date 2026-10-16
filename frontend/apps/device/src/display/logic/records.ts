import type { AllianceScore, LiveMatch } from "@tournament-admin/shared";

export interface WinLossTie {
  wins: number;
  losses: number;
  ties: number;
}

/** Each team's win-loss-tie record over fully scored two-alliance qualification matches. */
export function teamRecords(matches: LiveMatch[], scores: AllianceScore[]): Map<number, WinLossTie> {
  const byAlliance = new Map(scores.map((row) => [row.alliance_id, row.score]));
  const records = new Map<number, WinLossTie>();
  for (const match of matches) {
    if (match.round_type !== "qualification" || match.status !== "completed" || match.alliances.length !== 2) continue;
    const [first, second] = match.alliances;
    const a = byAlliance.get(first.id);
    const b = byAlliance.get(second.id);
    if (a === undefined || b === undefined) continue;
    for (const [alliance, own, other] of [
      [first, a, b],
      [second, b, a],
    ] as const) {
      for (const teamId of alliance.team_ids) {
        const record = records.get(teamId) ?? { wins: 0, losses: 0, ties: 0 };
        if (own > other) record.wins += 1;
        else if (own < other) record.losses += 1;
        else record.ties += 1;
        records.set(teamId, record);
      }
    }
  }
  return records;
}
