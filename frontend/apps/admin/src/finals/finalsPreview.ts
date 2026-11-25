/**
 * What the Finals set-up page shows before anything is created: each ranked
 * team's place in finals, and the rounds a knockout bracket will have. The
 * pairing rules mirror the server's `services/finals.py::auto_pairs`.
 */

export type FinalsMode = "picking" | "pairs_knockout" | "score_chase";

export interface FinalsCell {
  kind: "captain" | "invitable" | "alliance" | "out" | "excluded";
  /** Captain number, or alliance number (seed). */
  n?: number;
  /** A score-chase team that runs twice is in this alliance too. */
  n2?: number;
  /** A finalist only because a team above was excluded. */
  movedUp?: boolean;
}

/** Alliances formed automatically, in seed order (the server's `auto_pairs`). */
export function autoPairs(teamIds: number[], mode: "pairs_knockout" | "score_chase"): [number, number][] {
  const even = teamIds.length - (teamIds.length % 2);
  const pairs: [number, number][] = [];
  for (let index = 0; index < even; index += 2) pairs.push([teamIds[index], teamIds[index + 1]]);
  if (teamIds.length % 2 === 1 && mode === "score_chase" && teamIds.length >= 2) {
    pairs.push([teamIds[teamIds.length - 2], teamIds[teamIds.length - 1]]);
  }
  return pairs;
}

/** How many alliances a team count makes. */
export function allianceCount(teamCount: number, mode: FinalsMode): number {
  if (mode === "picking") return Math.floor(teamCount / 2);
  if (mode === "score_chase") return Math.ceil(teamCount / 2);
  return Math.floor(teamCount / 2);
}

export function finalsColumn(
  rankedTeamIds: number[],
  excluded: Set<number>,
  teamCount: number,
  mode: FinalsMode
): Map<number, FinalsCell> {
  const column = new Map<number, FinalsCell>();
  const eligible = rankedTeamIds.filter((teamId) => !excluded.has(teamId));
  for (const teamId of rankedTeamIds) {
    if (excluded.has(teamId)) column.set(teamId, { kind: "excluded" });
  }

  if (mode === "picking") {
    const captains = Math.floor(teamCount / 2);
    eligible.forEach((teamId, index) => {
      column.set(teamId, index < captains ? { kind: "captain", n: index + 1 } : { kind: "invitable" });
    });
    return column;
  }

  const finalists = eligible.slice(0, teamCount);
  const pairs = autoPairs(finalists, mode);
  for (const teamId of eligible) column.set(teamId, { kind: "out" });
  pairs.forEach((pair, index) => {
    for (const teamId of pair) {
      const existing = column.get(teamId);
      if (existing?.kind === "alliance") {
        existing.n2 = index + 1;
        continue;
      }
      const cell: FinalsCell = { kind: "alliance", n: index + 1 };
      if (rankedTeamIds.indexOf(teamId) >= teamCount) cell.movedUp = true;
      column.set(teamId, cell);
    }
  });
  return column;
}

/**
 * i18n key suffixes for a knockout bracket's rounds, first round to final:
 * "final", "semiFinals", "quarterFinals", then "roundOf16", "roundOf32" ….
 * The bracket rounds the alliance count up to a power of two (byes).
 */
export function roundLabels(alliances: number): string[] {
  if (alliances < 2) return [];
  const rounds = Math.ceil(Math.log2(alliances));
  const labels: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const remaining = 2 ** (rounds - round);
    if (remaining === 2) labels.push("final");
    else if (remaining === 4) labels.push("semiFinals");
    else if (remaining === 8) labels.push("quarterFinals");
    else labels.push(`roundOf${remaining}`);
  }
  return labels;
}

export type RoundChoice = "single" | "best2of3" | "best3of5";

export const ROUND_CHOICES: RoundChoice[] = ["single", "best2of3", "best3of5"];

const WINS: Record<RoundChoice, number> = { single: 1, best2of3: 2, best3of5: 3 };

/** Single matches throughout with a best 2 of 3 final. */
export function defaultRoundChoices(rounds: number): RoundChoice[] {
  return Array.from({ length: rounds }, (_, index) => (index === rounds - 1 ? "best2of3" : "single"));
}

/** The engine's per-round `wins_to_advance` list. */
export function winsToAdvance(choices: RoundChoice[]): number[] {
  return choices.map((choice) => WINS[choice]);
}
