import { useTranslation } from "react-i18next";
import { formatTime } from "@tournament-admin/shared";
import {
  useFields,
  useMatches,
  useNewestFinals,
  useScores,
  useSessionTimeZone,
  useTeamsById,
  type FinalsBracket,
  type Team,
} from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { roundName, seriesWins } from "../logic/bracket";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function Side({
  bracket,
  allianceId,
  teams,
  wins,
  winnerId,
  testId,
}: {
  bracket: FinalsBracket;
  allianceId: number | null;
  teams: Map<number, Team>;
  wins: number;
  winnerId: number | null;
  testId: string;
}) {
  const alliance = bracket.alliances.find((a) => a.id === allianceId);
  return (
    <div className={`matchup__side${winnerId !== null && winnerId === allianceId ? " is-winner" : ""}`} data-testid={testId}>
      <span className="matchup__seed">{alliance?.seed ?? ""}</span>
      <span className="matchup__teams">{alliance ? alliance.team_ids.map((id) => teams.get(id)?.number ?? "").join(" ") : "—"}</span>
      <span className="matchup__wins">{alliance ? wins : ""}</span>
    </div>
  );
}

function EliminationBracketScreen({ context }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const bracket = useNewestFinals(context.sessionId, context.divisionId);
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const fields = useFields(context.sessionId);
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(context.sessionId);
  const title = t("display.screens.elimination_bracket");
  if (bracket === undefined || !matches.data || !scores.data || !fields.data || !teams || !timeZone) return <WaitingForData title={title} />;
  if (bracket === null) return <ScreenNotice title={title} text={t("display.noEliminations")} />;

  if (bracket.format === "single_elimination") {
    const wins = seriesWins(bracket, matches.data, scores.data);
    const roundCount = Math.max(1, ...bracket.matchups.map((m) => m.round_number));
    const rounds = Array.from({ length: roundCount }, (_, i) =>
      bracket.matchups.filter((m) => m.round_number === i + 1).sort((a, b) => a.position - b.position)
    );
    return (
      <ScreenFrame title={title} className="bracket">
        <div className="bracket__rounds">
          {rounds.map((matchups, index) => (
            <section key={index} className="bracket__round">
              <h2 className="bracket__round-name">{roundName(t, index + 1, roundCount)}</h2>
              {matchups.map((matchup) => {
                const tally = wins.get(matchup.id) ?? { a: 0, b: 0 };
                return (
                  <div key={matchup.id} className="matchup" data-testid={`matchup-${matchup.id}`}>
                    <Side bracket={bracket} allianceId={matchup.alliance_a_id} teams={teams} wins={tally.a} winnerId={matchup.winner_alliance_id} testId={`side-${matchup.alliance_a_id}`} />
                    <Side bracket={bracket} allianceId={matchup.alliance_b_id} teams={teams} wins={tally.b} winnerId={matchup.winner_alliance_id} testId={`side-${matchup.alliance_b_id}`} />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </ScreenFrame>
    );
  }

  const results = [...bracket.results].sort((a, b) => a.rank - b.rank);
  const played = (allianceId: number) =>
    bracket.runs.filter((run) => run.bracket_alliance_id === allianceId && run.status === "completed").length;
  const currentRun = bracket.runs.find((run) => run.status !== "completed")?.match_id ?? null;
  const matchById = new Map(matches.data.map((m) => [m.id, m]));
  return (
    <ScreenFrame title={title} className="rankings">
      <div className="split">
        <table className="kiosk-table" aria-label={t("display.finalsRankings")}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.rank")}</th>
              <th scope="col">{t("display.col.team")}</th>
              <th scope="col">{t("display.col.matches")}</th>
              <th scope="col">{t("display.col.total")}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const alliance = bracket.alliances.find((a) => a.id === result.bracket_alliance_id);
              return (
                <tr key={result.bracket_alliance_id}>
                  <td className="kiosk-table__rank">{result.rank}</td>
                  <td>
                    {alliance?.team_ids.map((id) => (
                      <div key={id}>
                        <span className="kiosk-table__number">{teams.get(id)?.number ?? ""}</span> {teams.get(id)?.name ?? ""}
                      </div>
                    ))}
                  </td>
                  <td>{played(result.bracket_alliance_id)}</td>
                  <td className="kiosk-table__number">{result.score}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <aside className="side-panel" aria-label={t("display.schedulePanel")}>
          <h2 className="side-panel__title">{t("display.schedulePanel")}</h2>
          <table className="kiosk-table kiosk-table--compact">
            <tbody>
              {bracket.runs.map((run) => {
                const game = matchById.get(run.match_id);
                const alliance = bracket.alliances.find((a) => a.id === run.bracket_alliance_id);
                return (
                  <tr key={run.match_id} className={run.match_id === currentRun ? "is-current" : undefined}>
                    <th scope="row">{game?.label ?? ""}</th>
                    <td>
                      <TeamNumbers teamIds={alliance?.team_ids ?? []} teams={teams} station="all" />
                    </td>
                    <td className="side-panel__end">
                      {run.score !== null
                        ? run.score
                        : `${fields.data?.find((f) => f.id === game?.field_id)?.name ?? ""} ${
                            game?.scheduled_time ? formatTime(game.scheduled_time, timeZone, i18n.language) : ""
                          }`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </aside>
      </div>
    </ScreenFrame>
  );
}

export const eliminationBracketScreen: ScreenModule = {
  key: "elimination_bracket",
  scrolls: false,
  Component: EliminationBracketScreen,
};
