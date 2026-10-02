import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { formatMatchTime } from "../matchTime";
import type { RoundSummary } from "./roundSummary";

interface CurrentRoundsProps {
  sessionId: number;
  divisionId: number | null;
  sessionTimezone: string | null;
  rounds: RoundSummary[];
}

export function CurrentRounds({ sessionId, divisionId, sessionTimezone, rounds }: CurrentRoundsProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [targets, setTargets] = useState<RoundSummary[] | null>(null);

  const clearMutation = useMutation({
    // Sequential, one DELETE per round: the endpoint clears one round_type
    // at a time, and stopping at the first failure leaves the rest intact.
    mutationFn: async (toClear: RoundSummary[]) => {
      for (const round of toClear) {
        const params = new URLSearchParams({ session_id: String(sessionId), round_type: round.roundType });
        if (divisionId !== null) params.set("division_id", String(divisionId));
        await apiRequest(`/api/schedule?${params.toString()}`, { method: "DELETE" });
      }
    },
    onSuccess: () => setTargets(null),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
    },
  });

  const formatTime = (iso: string | null) =>
    iso ? formatMatchTime(iso, sessionTimezone, true, i18n.language) : t("sessions.schedule.rounds.noTime");

  function openDialog(toClear: RoundSummary[]) {
    clearMutation.reset();
    setTargets(toClear);
  }

  const isAll = targets !== null && targets.length > 1;
  const scored = targets?.reduce((sum, round) => sum + round.scoredCount, 0) ?? 0;
  const phrase = targets === null || scored === 0
    ? null
    : isAll
      ? t("sessions.schedule.rounds.clearAllPhrase")
      : targets[0].roundType;
  const body = targets === null
    ? ""
    : [
        isAll
          ? t("sessions.schedule.rounds.clearAllBody")
          : t("sessions.schedule.rounds.clearBody", { count: targets[0].matchCount }),
        scored > 0 ? t("sessions.schedule.rounds.scoredWarning", { count: scored }) : "",
      ]
        .filter(Boolean)
        .join(" ");

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.rounds.heading")}</h2>
      {rounds.length === 0 ? (
        <p>{t("sessions.schedule.rounds.none")}</p>
      ) : (
        <>
          <table className="schedule-table">
            <thead>
              <tr>
                <th>{t("sessions.schedule.rounds.columnRound")}</th>
                <th>{t("sessions.schedule.rounds.columnMatches")}</th>
                <th>{t("sessions.schedule.rounds.columnScored")}</th>
                <th>{t("sessions.schedule.rounds.columnFirst")}</th>
                <th>{t("sessions.schedule.rounds.columnLast")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rounds.map((round) => (
                <tr key={round.roundType}>
                  <td>{round.roundType}</td>
                  <td>{round.matchCount}</td>
                  <td>{round.scoredCount}</td>
                  <td>{formatTime(round.firstTime)}</td>
                  <td>{formatTime(round.lastTime)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={t("sessions.schedule.rounds.clearAriaLabel", { round: round.roundType })}
                      onClick={() => openDialog([round])}
                    >
                      {t("sessions.schedule.rounds.clearAction")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rounds.length > 1 && (
            <button type="button" className="btn btn-danger btn-small" onClick={() => openDialog(rounds)}>
              {t("sessions.schedule.rounds.clearAllAction")}
            </button>
          )}
        </>
      )}
      {targets !== null && (
        <ConfirmDialog
          key={targets.map((round) => round.roundType).join(",")}
          heading={
            isAll
              ? t("sessions.schedule.rounds.clearAllHeading")
              : t("sessions.schedule.rounds.clearHeading", { round: targets[0].roundType })
          }
          body={body}
          confirmLabel={t("sessions.schedule.rounds.confirmClear")}
          cancelLabel={t("sessions.cancelAction")}
          requiredPhrase={phrase}
          phrasePrompt={phrase ? t("sessions.schedule.rounds.typeToConfirm", { phrase }) : undefined}
          isPending={clearMutation.isPending}
          error={clearMutation.isError ? apiErrorMessage(clearMutation.error, t("errors.generic")) : null}
          onConfirm={() => clearMutation.mutate(targets)}
          onCancel={() => setTargets(null)}
        />
      )}
    </section>
  );
}
