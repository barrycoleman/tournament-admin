import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { FinalsBracket, RankingRead, TeamSummary } from "../types";
import { useDeleteFinals, useSelectionMutations, type FinalsScope } from "./useFinals";

interface AllianceSelectionPanelProps {
  scope: FinalsScope;
  bracket: FinalsBracket;
  rankings: RankingRead[];
  teams: TeamSummary[];
}

/** "100 Team name"; the id alone when the team is not in the roster. */
export function teamLabel(teamId: number | null | undefined, teams: Map<number, TeamSummary>): string {
  if (teamId === null || teamId === undefined) return "";
  const team = teams.get(teamId);
  return team ? `${team.number} ${team.name}`.trim() : String(teamId);
}

/** Partner picking: alliances filling in on the left, teams that can be invited on the right. */
export function AllianceSelectionPanel({ scope, bracket, rankings, teams }: AllianceSelectionPanelProps) {
  const { t } = useTranslation();
  const selection = bracket.selection;
  const steps = useSelectionMutations(scope, bracket.id);
  const startOver = useDeleteFinals(scope, bracket.id);
  const [confirmingStartOver, setConfirmingStartOver] = useState(false);

  const teamById = new Map(teams.map((team) => [team.id, team]));
  const rankByTeam = new Map(rankings.map((row) => [row.team_id, row.rank]));
  const label = (teamId: number | null | undefined) => teamLabel(teamId, teamById);

  if (!selection) return null;

  const formed = [...bracket.alliances].sort((a, b) => a.seed - b.seed);
  const pending = selection.pending_team_id;
  const hasInvite = pending !== null;
  const busy = Object.values(steps).some((step) => step.isPending);
  const error = Object.values(steps).find((step) => step.error)?.error ?? null;
  const last = selection.last_step;
  const canFinish =
    (selection.captain_team_id === null || selection.invitable_team_ids.length === 0) &&
    selection.alliances_formed >= 2;

  const rows = Array.from({ length: selection.alliances_target }, (_, index) => {
    const seed = index + 1;
    const alliance = formed.find((candidate) => candidate.seed === seed);
    const current = !alliance && seed === selection.alliances_formed + 1 && selection.captain_team_id !== null;
    return { seed, alliance, current };
  });

  function reportBeforeStep(step: () => void) {
    for (const mutation of Object.values(steps)) mutation.reset();
    step();
  }

  return (
    <div className="finals-picking">
      <div className="finals-picking__alliances">
        <h2 className="finals-picking__heading">{t("sessions.finals.picking.alliances")}</h2>
        <table className="table" aria-label={t("sessions.finals.picking.alliances")}>
          <thead>
            <tr>
              <th className="table__num">#</th>
              <th>{t("sessions.finals.picking.captain")}</th>
              <th>{t("sessions.finals.picking.partner")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ seed, alliance, current }) => (
              <tr
                key={seed}
                className={current ? "finals-picking__current" : undefined}
                aria-current={current ? "true" : undefined}
              >
                <td className="table__num">{seed}</td>
                <td>{alliance ? label(alliance.team_ids[0]) : current ? label(selection.captain_team_id) : ""}</td>
                <td>
                  {alliance ? (
                    label(alliance.team_ids[1])
                  ) : current && hasInvite ? (
                    <span>
                      {label(pending)} <strong>{t("sessions.finals.picking.waiting")}</strong>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="finals-picking__actions">
          <button
            type="button"
            className="btn btn-success"
            disabled={!hasInvite || busy}
            onClick={() => pending !== null && reportBeforeStep(() => steps.accept.mutate(pending))}
          >
            {t("sessions.finals.picking.accept")}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!hasInvite || busy}
            onClick={() => pending !== null && reportBeforeStep(() => steps.decline.mutate(pending))}
          >
            {t("sessions.finals.picking.decline")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasInvite || busy}
            onClick={() => reportBeforeStep(() => steps.cancel.mutate())}
          >
            {t("sessions.finals.picking.cancelInvite")}
          </button>
        </div>
        {hasInvite && <p className="hint">{t("sessions.finals.picking.onBehalf", { team: label(pending) })}</p>}

        <div className="finals-picking__undo">
          <button
            type="button"
            className="btn btn-link"
            disabled={!last || busy}
            onClick={() => reportBeforeStep(() => steps.undo.mutate())}
          >
            {t("sessions.finals.picking.undo")}
          </button>{" "}
          {last && (
            <span className="table__secondary">
              {t(last.kind === "decline" ? "sessions.finals.picking.lastDeclined" : "sessions.finals.picking.lastJoined", {
                team: label(last.team_id),
                captain: label(last.captain_team_id),
              })}
            </span>
          )}
        </div>

        {error != null && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(error, t("sessions.finals.genericError"))}
          </p>
        )}

        <div className="finals-picking__actions">
          {canFinish && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => reportBeforeStep(() => steps.finish.mutate())}
            >
              {t("sessions.finals.picking.finish", { count: selection.alliances_formed })}
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={() => setConfirmingStartOver(true)}>
            {t("sessions.finals.startOver")}
          </button>
        </div>
      </div>

      <div className="finals-picking__teams">
        <h2 className="finals-picking__heading" id="finals-picking-invitable">
          {t("sessions.finals.cell.invitable")}
        </h2>
        <ul className="finals-picking__list" aria-labelledby="finals-picking-invitable">
          {[...selection.declined_team_ids.map((id) => ({ id, declined: true })), ...selection.invitable_team_ids.map((id) => ({ id, declined: false }))]
            .sort((a, b) => (rankByTeam.get(a.id) ?? 0) - (rankByTeam.get(b.id) ?? 0))
            .map(({ id, declined }) => (
              <li key={id} className={declined ? "finals-picking__declined" : undefined}>
                <span className="table__num">{t("sessions.finals.picking.rank", { rank: rankByTeam.get(id) ?? "?" })}</span>{" "}
                <span className="finals-picking__team">{label(id)}</span>
                {declined ? (
                  <span> {t("sessions.finals.picking.declinedTag")}</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={hasInvite || busy}
                    onClick={() => reportBeforeStep(() => steps.invite.mutate(id))}
                  >
                    {t("sessions.finals.picking.invite")}
                  </button>
                )}
              </li>
            ))}
        </ul>
        <p className="hint">{t("sessions.finals.picking.tabletsHint")}</p>
      </div>

      {confirmingStartOver && (
        <ConfirmDialog
          heading={t("sessions.finals.startOverHeading")}
          body={t("sessions.finals.startOverPickingBody")}
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
