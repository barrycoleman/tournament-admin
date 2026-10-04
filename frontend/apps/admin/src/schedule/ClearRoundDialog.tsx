import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { roundTypeLabel } from "../roundTypeLabel";
import type { ScheduledRound } from "../types";

interface ClearRoundDialogProps {
  sessionId: number;
  divisionId: number | null;
  targets: ScheduledRound[];
  onDone: () => void;
}

/** Confirms clearing one round (or all of them); scored rounds need their name typed. */
export function ClearRoundDialog({ sessionId, divisionId, targets, onDone }: ClearRoundDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const clear = useMutation({
    // One DELETE per round, in order; stopping at the first failure leaves the rest intact.
    mutationFn: async () => {
      for (const round of targets) {
        const params = new URLSearchParams({ session_id: String(sessionId), round_type: round.round_type });
        if (divisionId !== null) params.set("division_id", String(divisionId));
        await apiRequest(`/api/schedule?${params.toString()}`, { method: "DELETE" });
      }
    },
    onSuccess: onDone,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", sessionId] });
      // A cached dry run was checked against the rounds just cleared.
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
  });
  const isAll = targets.length > 1;
  const scored = targets.reduce((sum, round) => sum + round.scored_count, 0);
  const phrase =
    scored === 0 ? null : isAll ? t("sessions.schedule.rounds.clearAllPhrase") : roundTypeLabel(t, targets[0].round_type);
  const body = [
    isAll
      ? t("sessions.schedule.rounds.clearAllBody")
      : t("sessions.schedule.rounds.clearBody", { count: targets[0].match_count }),
    scored > 0 ? t("sessions.schedule.rounds.scoredWarning", { count: scored }) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <ConfirmDialog
      heading={
        isAll
          ? t("sessions.schedule.rounds.clearAllHeading")
          : t("sessions.schedule.rounds.clearHeading", { round: roundTypeLabel(t, targets[0].round_type) })
      }
      body={body}
      confirmLabel={t("sessions.schedule.rounds.confirmClear")}
      cancelLabel={t("sessions.cancelAction")}
      requiredPhrase={phrase}
      phrasePrompt={phrase ? t("sessions.schedule.rounds.typeToConfirm", { phrase }) : undefined}
      isPending={clear.isPending}
      error={clear.isError ? apiErrorMessage(clear.error, t("errors.generic")) : null}
      onConfirm={() => clear.mutate()}
      onCancel={onDone}
    />
  );
}
