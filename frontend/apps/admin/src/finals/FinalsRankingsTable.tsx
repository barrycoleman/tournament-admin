import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FinalsExclusion, FinalsExclusionReason, TeamSummary } from "../types";
import type { FinalsCell } from "./finalsPreview";

export interface FinalsRankingRow {
  teamId: number;
  rank: number;
  team: TeamSummary | undefined;
  cell: FinalsCell | undefined;
  exclusion: FinalsExclusion | undefined;
}

interface FinalsRankingsTableProps {
  rows: FinalsRankingRow[];
  /** The last finalist, drawn with the cut line under it (automatic pairs only). */
  cutAfterTeamId: number | null;
  busy: boolean;
  onExclude: (teamId: number, reason: FinalsExclusionReason) => void;
  onUndo: (exclusionId: number) => void;
}

const REASONS: FinalsExclusionReason[] = ["disqualified", "left_early"];

function FinalsCellText({ cell, exclusion }: { cell: FinalsCell | undefined; exclusion: FinalsExclusion | undefined }) {
  const { t } = useTranslation();
  if (exclusion) {
    return (
      <span className="finals-rankings__reason">
        {t("sessions.finals.cell.excluded", { reason: t(`sessions.finals.reasonInline.${exclusion.reason}`) })}
      </span>
    );
  }
  if (!cell) return null;
  switch (cell.kind) {
    case "captain":
      return <strong>{t("sessions.finals.cell.captain", { n: cell.n })}</strong>;
    case "invitable":
      return <>{t("sessions.finals.cell.invitable")}</>;
    case "alliance": {
      const text =
        cell.n2 !== undefined
          ? t("sessions.finals.cell.twoAlliances", { n: cell.n, n2: cell.n2 })
          : t("sessions.finals.cell.alliance", { n: cell.n });
      return <>{cell.movedUp ? t("sessions.finals.cell.movedUp", { text }) : text}</>;
    }
    case "out":
      return <span className="table__secondary">{t("sessions.finals.cell.out")}</span>;
    default:
      return null;
  }
}

/** The set-up page's left side: rankings with each team's place in finals and Exclude / Undo. */
export function FinalsRankingsTable({ rows, cutAfterTeamId, busy, onExclude, onUndo }: FinalsRankingsTableProps) {
  const { t } = useTranslation();
  const [excluding, setExcluding] = useState<{ teamId: number; reason: FinalsExclusionReason } | null>(null);

  return (
    <div className="table-wrap">
      <table className="table finals-rankings" aria-label={t("sessions.finals.rankingsLabel")}>
        <thead>
          <tr>
            <th className="table__num">{t("sessions.finals.columnRank")}</th>
            <th>{t("sessions.finals.columnTeam")}</th>
            <th>{t("sessions.finals.columnFinals")}</th>
            <th className="table__actions" aria-label={t("sessions.finals.columnActions")} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const classes = [
              row.exclusion ? "finals-rankings__excluded" : "",
              row.teamId === cutAfterTeamId ? "finals-rankings__cut" : "",
            ].filter(Boolean);
            const isExcluding = excluding?.teamId === row.teamId;
            return (
              <tr key={row.teamId} className={classes.join(" ") || undefined}>
                <td className="table__num">{row.rank}</td>
                <td>
                  <span className="finals-rankings__team">
                    <span className="finals-rankings__number">{row.team?.number ?? row.teamId}</span>{" "}
                    <span className="table__secondary">{row.team?.name}</span>
                  </span>
                </td>
                <td>
                  <FinalsCellText cell={row.cell} exclusion={row.exclusion} />
                </td>
                <td className="table__actions">
                  {row.exclusion ? (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => onUndo(row.exclusion!.id)}
                    >
                      {t("sessions.finals.undo")}
                    </button>
                  ) : isExcluding ? (
                    <span className="finals-rankings__exclude">
                      <select
                        aria-label={t("sessions.finals.reasonLabel")}
                        className="select"
                        value={excluding.reason}
                        onChange={(event) =>
                          setExcluding({ teamId: row.teamId, reason: event.target.value as FinalsExclusionReason })
                        }
                      >
                        {REASONS.map((reason) => (
                          <option key={reason} value={reason}>
                            {t(`sessions.finals.reason.${reason}`)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        disabled={busy}
                        onClick={() => {
                          onExclude(row.teamId, excluding.reason);
                          setExcluding(null);
                        }}
                      >
                        {t("sessions.finals.excludeConfirm")}
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => setExcluding(null)}>
                        {t("sessions.finals.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => setExcluding({ teamId: row.teamId, reason: "disqualified" })}
                    >
                      {t("sessions.finals.exclude")}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
