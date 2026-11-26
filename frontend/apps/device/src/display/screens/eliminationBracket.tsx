import { useTranslation } from "react-i18next";
import { useMatches, useNewestFinals, useRanks, useScores, useTeamsById, type FinalsBracket, type Team } from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { roundName, seriesWins } from "../logic/bracket";
import { matchSides, pairSides } from "../logic/sides";
import { tableScreenClass } from "../logic/tableScreen";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function Side({
  bracket,
  allianceId,
  teams,
  wins,
  winnerId,
  testId,
  side,
}: {
  bracket: FinalsBracket;
  allianceId: number | null;
  teams: Map<number, Team>;
  wins: number;
  winnerId: number | null;
  testId: string;
  side: "red" | "blue";
}) {
  const alliance = bracket.alliances.find((a) => a.id === allianceId);
  // A slot still waiting for its alliance (TBD) is neutral; only a filled slot takes its side colour.
  const tone = allianceId === null ? "empty" : side;
  return (
    <div className={`matchup__side matchup__side--${tone}${winnerId !== null && winnerId === allianceId ? " is-winner" : ""}`} data-testid={testId}>
      <span className="matchup__seed">{alliance?.seed ?? ""}</span>
      <span className="matchup__teams">{alliance ? alliance.team_ids.map((id) => teams.get(id)?.number ?? "").join(" ") : "—"}</span>
      <span className="matchup__wins">{alliance ? wins : ""}</span>
    </div>
  );
}

function EliminationBracketScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const bracket = useNewestFinals(context.sessionId, context.divisionId);
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const teams = useTeamsById();
  // The finals were seeded from the bracket's division's qualification ranks.
  const ranks = useRanks(context.sessionId, bracket?.division_id ?? context.divisionId);
  const title = t("display.screens.elimination_bracket");
  if (bracket === undefined || !matches.data || !scores.data || !teams) return <WaitingForData title={title} />;
  if (bracket === null) return <ScreenNotice title={title} text={t("display.noEliminations")} />;

  if (bracket.format === "single_elimination") {
    const wins = seriesWins(bracket, matches.data, scores.data);
    const roundCount = Math.max(1, ...bracket.matchups.map((m) => m.round_number));
    const rounds = Array.from({ length: roundCount }, (_, i) =>
      bracket.matchups.filter((m) => m.round_number === i + 1).sort((a, b) => a.position - b.position)
    );
    return (
      <ScreenFrame title={title} className="bracket">
        <div className="bracket__rounds" style={{ gridTemplateColumns: `repeat(${roundCount}, 1fr)` }}>
          {rounds.map((_, index) => (
            <h2 key={index} className="bracket__round-name">{roundName(t, index + 1, roundCount)}</h2>
          ))}
          {rounds.map((matchups, index) => {
            // Every round splits the same height into equal slots, one per position, so a matchup
            // sits exactly halfway between the two matchups that feed it.
            const slotCount = Math.max(1, 2 ** (roundCount - index - 1), ...matchups.map((m) => m.position + 1));
            const byPosition = new Map(matchups.map((m) => [m.position, m]));
            return (
              <section key={index} className="bracket__round">
                {Array.from({ length: slotCount }, (_, position) => {
                  const matchup = byPosition.get(position);
                  if (!matchup) return <div key={position} className="bracket__slot" />;
                  const tally = wins.get(matchup.id) ?? { a: 0, b: 0 };
                  return (
                    <div key={position} className="bracket__slot">
                      <div className="matchup" data-testid={`matchup-${matchup.id}`}>
                        <Side bracket={bracket} allianceId={matchup.alliance_a_id} teams={teams} wins={tally.a} winnerId={matchup.winner_alliance_id} testId={`side-${matchup.alliance_a_id}`} side="red" />
                        <Side bracket={bracket} allianceId={matchup.alliance_b_id} teams={teams} wins={tally.b} winnerId={matchup.winner_alliance_id} testId={`side-${matchup.alliance_b_id}`} side="blue" />
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </ScreenFrame>
    );
  }

  // One row per run: ranked runs first by rank, then the runs still to score in run order.
  const rankOf = new Map(bracket.results.map((r) => [r.bracket_alliance_id, r]));
  const rows = bracket.runs
    .map((run, order) => ({ run, order, result: run.bracket_alliance_id === null ? undefined : rankOf.get(run.bracket_alliance_id) }))
    .sort((a, b) => (a.result?.rank ?? Infinity) - (b.result?.rank ?? Infinity) || a.order - b.order);
  const currentRun = bracket.runs.find((run) => run.status !== "completed")?.match_id ?? null;
  const matchById = new Map(matches.data.map((m) => [m.id, m]));
  const side = (ids: number[], tone: "red" | "blue") => (
    <td className={`finals-table__side finals-table__side--${tone}`}>
      {ids.map((id) => (
        <div key={id}>
          <span className={`rank-table__number team-numbers--${tone}`}>{teams.get(id)?.number ?? ""}</span>{" "}
          <span className="rank-table__name">{teams.get(id)?.name ?? ""}</span>
        </div>
      ))}
    </td>
  );
  return (
    <ScreenFrame title={title} className={`finals ${tableScreenClass(context)}`}>
      <table className="kiosk-table rank-table finals-table" aria-label={t("display.finalsRankings")}>
        <thead>
          <tr>
            <th scope="col">{t("display.col.rank")}</th>
            <th scope="col">{t("display.col.match")}</th>
            <th scope="col">{t("display.col.red")}</th>
            <th scope="col">{t("display.col.blue")}</th>
            <th scope="col">{t("display.col.score")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ run, result }) => {
            const game = matchById.get(run.match_id);
            const alliance = bracket.alliances.find((a) => a.id === run.bracket_alliance_id);
            const sides = game ? matchSides(game, ranks) : pairSides(alliance?.team_ids ?? [], ranks);
            const score = result?.score ?? run.score;
            return (
              <tr key={run.match_id} className={run.match_id === currentRun ? "is-current" : undefined}>
                <td className={`rank-table__rank${result && result.rank <= 3 ? " is-top" : ""}`}>{result?.rank ?? "–"}</td>
                <td className="rank-table__strong">{game?.label ?? ""}</td>
                {side(sides.red, "red")}
                {side(sides.blue, "blue")}
                <td className="rank-table__strong">{score ?? "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScreenFrame>
  );
}

export const eliminationBracketScreen: ScreenModule = {
  key: "elimination_bracket",
  scrolls: false,
  Component: EliminationBracketScreen,
};
