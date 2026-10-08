import { Fragment, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../types";
import { buildAttemptRows, filterAttemptRows } from "./attemptsTable";
import { EditAttemptDialog } from "./EditAttemptDialog";

export function AttemptsTable({
  sessionId,
  types,
  attempts,
  teams,
}: {
  sessionId: number;
  types: SessionSkillsType[];
  attempts: SkillsAttemptRead[];
  /** Every team (not just checked-in ones): a team may have been un-checked-in after recording. */
  teams: TeamSummary[];
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const filterId = useId();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<SkillsAttemptRead | null>(null);
  const rows = useMemo(() => buildAttemptRows(attempts, teams, types), [attempts, teams, types]);
  const visible = filterAttemptRows(rows, filter);
  const editingType = editing ? types.find((type) => type.key === editing.skills_type) : undefined;
  const editingTeam = editing ? teams.find((team) => team.id === editing.team_id) : undefined;

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("skills.table.heading")}</h2>
      <div className="field">
        <label className="field__label" htmlFor={filterId}>
          {t("skills.table.filterLabel")}
        </label>
        <input
          id={filterId}
          className="input"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p className="table__empty">{t("skills.table.empty")}</p>
      ) : visible.length === 0 ? (
        <p className="table__empty">{t("skills.table.noMatch", { text: filter.trim() })}</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-labelledby={headingId}>
            <thead>
              <tr>
                <th>{t("skills.table.columnTeam")}</th>
                {types.map((type) => (
                  <th key={type.key}>{type.label}</th>
                ))}
                <th className="table__num">{t("skills.table.columnOverall")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.team.id}>
                  <td>
                    {row.team.number} <span className="table__secondary">{row.team.name}</span>
                  </td>
                  {types.map((type) => (
                    <td key={type.key} className="skills-attempts__cell">
                      {row.byType[type.key].map((attempt, index) => (
                        <Fragment key={attempt?.id ?? `empty-${index}`}>
                          {index > 0 && <span aria-hidden="true"> · </span>}
                          {attempt ? (
                            <button
                              type="button"
                              className="btn-link"
                              aria-label={t("skills.table.editAttempt", {
                                label: type.label,
                                n: attempt.number,
                                number: row.team.number,
                                score: attempt.score,
                              })}
                              onClick={() => setEditing(attempt)}
                            >
                              {attempt.score}
                            </button>
                          ) : (
                            <span>{t("skills.table.emptySlot")}</span>
                          )}
                        </Fragment>
                      ))}
                    </td>
                  ))}
                  <td className="table__num">{row.overall}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && editingType && editingTeam && (
        <EditAttemptDialog
          key={editing.id}
          sessionId={sessionId}
          attempt={editing}
          type={editingType}
          teamNumber={editingTeam.number}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
