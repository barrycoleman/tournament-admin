import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { FinalsAlliance, FinalsBracket, TeamSummary } from "../types";
import { teamLabel } from "./AllianceSelectionPanel";
import { useDeleteFinals, useMarkUnavailable, type FinalsScope } from "./useFinals";

interface FinalsProgressProps {
  scope: FinalsScope;
  bracket: FinalsBracket;
  teams: TeamSummary[];
}

/** Finals that exist: who is in them, "Can't play" while knockout games remain, Start over, and a way into Match Control. */
export function FinalsProgress({ scope, bracket, teams }: FinalsProgressProps) {
  const { t } = useTranslation();
  const startOver = useDeleteFinals(scope, bracket.id);
  const unavailable = useMarkUnavailable(scope, bracket.id);
  const [confirmingStartOver, setConfirmingStartOver] = useState(false);
  const [forfeiting, setForfeiting] = useState<FinalsAlliance | null>(null);
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const inProgress = bracket.status === "in_progress";
  const canForfeit = inProgress && bracket.format === "single_elimination";
  const alliances = [...bracket.alliances].sort((a, b) => a.seed - b.seed);

  return (
    <div className="panel finals-progress">
      <p>{t(`sessions.finals.status.${bracket.status}`)}</p>
      <table className="table" aria-label={t("sessions.finals.progress.alliances")}>
        <thead>
          <tr>
            <th className="table__num">{t("sessions.finals.progress.seed")}</th>
            <th>{t("sessions.finals.progress.teams")}</th>
            <th className="table__actions" />
          </tr>
        </thead>
        <tbody>
          {alliances.map((alliance) => (
            <tr key={alliance.id}>
              <td className="table__num">{alliance.seed}</td>
              <td>{alliance.team_ids.map((id) => teamLabel(id, teamById)).join(" + ")}</td>
              <td className="table__actions">
                {alliance.unavailable ? (
                  <span className="table__secondary">{t("sessions.finals.progress.forfeited")}</span>
                ) : (
                  canForfeit && (
                    <button type="button" className="btn btn-small" onClick={() => setForfeiting(alliance)}>
                      {t("sessions.finals.progress.cantPlay")}
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="finals-picking__actions">
        <Link className="btn btn-primary" to="/match-control">
          {t("sessions.finals.progress.openMatchControl")}
        </Link>
        {inProgress && (
          <button type="button" className="btn btn-danger" onClick={() => setConfirmingStartOver(true)}>
            {t("sessions.finals.startOver")}
          </button>
        )}
      </div>

      {forfeiting && (
        <ConfirmDialog
          heading={t("sessions.finals.progress.cantPlayHeading", {
            teams: forfeiting.team_ids.map((id) => teamLabel(id, teamById)).join(" + "),
          })}
          body={t("sessions.finals.progress.cantPlayBody")}
          confirmLabel={t("sessions.finals.progress.cantPlayConfirm")}
          cancelLabel={t("sessions.finals.cancel")}
          isPending={unavailable.isPending}
          error={unavailable.error ? apiErrorMessage(unavailable.error, t("sessions.finals.genericError")) : null}
          onConfirm={() => unavailable.mutate(forfeiting.id, { onSuccess: () => setForfeiting(null) })}
          onCancel={() => {
            unavailable.reset();
            setForfeiting(null);
          }}
        />
      )}
      {confirmingStartOver && (
        <ConfirmDialog
          heading={t("sessions.finals.startOverHeading")}
          body={t("sessions.finals.startOverBody")}
          confirmLabel={t("sessions.finals.startOver")}
          cancelLabel={t("sessions.finals.cancel")}
          isPending={startOver.isPending}
          error={startOver.error ? apiErrorMessage(startOver.error, t("sessions.finals.genericError")) : null}
          onConfirm={() => startOver.mutate(undefined, { onSuccess: () => setConfirmingStartOver(false) })}
          onCancel={() => {
            startOver.reset();
            setConfirmingStartOver(false);
          }}
        />
      )}
    </div>
  );
}
