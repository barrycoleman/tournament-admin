import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import type { Division } from "../types";
import type { OutOfScopeRound } from "./roundSummary";

interface OutOfScopeRoundsProps {
  sessionId: number;
  divisions: Division[];
  rounds: OutOfScopeRound[];
}

/**
 * Rounds generated under a different division setup than the event has now.
 * They hold their fields (a field delete 409s), so they stay clearable here,
 * each in the scope it was actually generated in.
 */
export function OutOfScopeRounds({ sessionId, divisions, rounds }: OutOfScopeRoundsProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<OutOfScopeRound | null>(null);

  const clearMutation = useMutation({
    mutationFn: async (round: OutOfScopeRound) => {
      const params = new URLSearchParams({ session_id: String(sessionId), round_type: round.summary.roundType });
      if (round.divisionId !== null) params.set("division_id", String(round.divisionId));
      await apiRequest(`/api/schedule?${params.toString()}`, { method: "DELETE" });
    },
    onSuccess: () => setTarget(null),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
    },
  });

  if (rounds.length === 0) return null;

  const scopeLabel = (divisionId: number | null) =>
    divisionId === null
      ? t("sessions.schedule.outOfScope.noDivision")
      : (divisions.find((division) => division.id === divisionId)?.name ??
        t("sessions.schedule.outOfScope.deletedDivision"));

  const scored = target?.summary.scoredCount ?? 0;
  const phrase = target !== null && scored > 0 ? target.summary.roundType : null;

  return (
    <section className="panel alert-warning" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.outOfScope.heading")}</h2>
      <p>{t("sessions.schedule.outOfScope.body")}</p>
      <table className="schedule-table">
        <thead>
          <tr>
            <th>{t("sessions.schedule.outOfScope.columnScope")}</th>
            <th>{t("sessions.schedule.rounds.columnRound")}</th>
            <th>{t("sessions.schedule.rounds.columnMatches")}</th>
            <th>{t("sessions.schedule.rounds.columnScored")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rounds.map((round) => (
            <tr key={`${round.divisionId ?? "none"}:${round.summary.roundType}`}>
              <td>{scopeLabel(round.divisionId)}</td>
              <td>{round.summary.roundType}</td>
              <td>{round.summary.matchCount}</td>
              <td>{round.summary.scoredCount}</td>
              <td>
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={t("sessions.schedule.outOfScope.clearAriaLabel", {
                    round: round.summary.roundType,
                    scope: scopeLabel(round.divisionId),
                  })}
                  onClick={() => {
                    clearMutation.reset();
                    setTarget(round);
                  }}
                >
                  {t("sessions.schedule.rounds.clearAction")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target !== null && (
        <ConfirmDialog
          key={`${target.divisionId ?? "none"}:${target.summary.roundType}`}
          heading={t("sessions.schedule.outOfScope.clearHeading", {
            round: target.summary.roundType,
            scope: scopeLabel(target.divisionId),
          })}
          body={[
            t("sessions.schedule.rounds.clearBody", { count: target.summary.matchCount }),
            scored > 0 ? t("sessions.schedule.rounds.scoredWarning", { count: scored }) : "",
          ]
            .filter(Boolean)
            .join(" ")}
          confirmLabel={t("sessions.schedule.rounds.confirmClear")}
          cancelLabel={t("sessions.cancelAction")}
          requiredPhrase={phrase}
          phrasePrompt={phrase ? t("sessions.schedule.rounds.typeToConfirm", { phrase }) : undefined}
          isPending={clearMutation.isPending}
          error={clearMutation.isError ? apiErrorMessage(clearMutation.error, t("errors.generic")) : null}
          onConfirm={() => clearMutation.mutate(target)}
          onCancel={() => setTarget(null)}
        />
      )}
    </section>
  );
}
