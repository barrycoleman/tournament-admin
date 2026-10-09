import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { AwardRead, AwardSlotRead } from "../types";
import type { SlotActions } from "./AwardsView";
import { awardsKey, slotKey, teamHistoryKey } from "./useAwards";
import { WinnerDialog } from "./WinnerDialog";

export function SlotActionButtons({
  sessionId,
  award,
  slot,
  locked,
  role,
}: {
  sessionId: number;
  award: AwardRead;
  slot: AwardSlotRead;
  locked: boolean;
  role: "admin" | "judge";
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const clear = useMutation({
    mutationFn: () => apiRequest(`/api/awards/${award.id}/slots/${slotKey(slot)}`, { method: "DELETE" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: awardsKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: teamHistoryKey(sessionId) });
    },
  });

  const judged = award.kind === "judged";
  if (!judged && role !== "admin") return null;
  const hasStored = judged ? slot.status === "judged" : slot.status === "overridden";
  const name = `${award.name} ${slot.division_name ?? t("awards.eventSlot")}`;
  return (
    <span className="award-card__actions">
      <button
        type="button"
        className="btn btn-small"
        disabled={locked}
        aria-label={`${t(judged ? "awards.winner.chooseAction" : "awards.winner.overrideAction")}: ${name}`}
        onClick={() => setOpen(true)}
      >
        {t(judged ? "awards.winner.chooseAction" : "awards.winner.overrideAction")}
      </button>
      {hasStored && (
        <button
          type="button"
          className="btn btn-small"
          disabled={locked || clear.isPending}
          aria-label={`${t(judged ? "awards.winner.clearAction" : "awards.winner.removeOverrideAction")}: ${name}`}
          onClick={() => clear.mutate()}
        >
          {t(judged ? "awards.winner.clearAction" : "awards.winner.removeOverrideAction")}
        </button>
      )}
      {clear.isError && (
        <span className="alert alert-danger" role="alert">
          {apiErrorMessage(clear.error, t("errors.generic"))}
        </span>
      )}
      {open && (
        <WinnerDialog
          sessionId={sessionId}
          award={award}
          slot={slot}
          mode={judged ? "judged" : "override"}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

export function slotActionsFor(sessionId: number, role: "admin" | "judge"): SlotActions {
  return (award, slot, locked) => (
    <SlotActionButtons sessionId={sessionId} award={award} slot={slot} locked={locked} role={role} />
  );
}
