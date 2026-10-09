import { useId, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import type { FinalizeRead } from "../types";
import { awardsKey, teamHistoryKey } from "./useAwards";

export function FinalizeAwardsDialog({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const path = `/api/sessions/${sessionId}/awards/finalize`;
  const dryRun = useQuery({
    queryKey: ["awardsFinalizeCheck", sessionId],
    queryFn: () => apiRequest<FinalizeRead>(path, { method: "POST", body: { confirm: false } }),
    gcTime: 0,
  });
  // React Query publishes isPending asynchronously, so a ref blocks a second click in the same tick.
  const sending = useRef(false);
  const finalize = useMutation({
    mutationFn: () => apiRequest<FinalizeRead>(path, { method: "POST", body: { confirm: true } }),
    onSuccess: onClose,
    onSettled: () => {
      sending.current = false;
      queryClient.invalidateQueries({ queryKey: awardsKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: teamHistoryKey(sessionId) });
    },
  });
  const warnings = dryRun.data?.warnings ?? [];

  return (
    <Modal labelledBy={headingId} onCancel={() => !finalize.isPending && onClose()}>
      <h2 id={headingId}>{t("awards.finalize.heading")}</h2>
      <p>{t("awards.finalize.body")}</p>
      {dryRun.isLoading && <p>{t("awards.finalize.checking")}</p>}
      {dryRun.data && warnings.length === 0 && <p>{t("awards.finalize.noWarnings")}</p>}
      {warnings.length > 0 && (
        <>
          <p>{t("awards.finalize.warningsIntro")}</p>
          <ul>
            {warnings.map((w) => (
              <li key={`${w.award_id}-${w.division_id ?? "event"}`}>
                {t("awards.finalize.warning", {
                  award: w.award_name,
                  slot: w.division_name ?? t("awards.eventSlot"),
                  status: t(`awards.status.${w.status}`),
                })}
              </li>
            ))}
          </ul>
        </>
      )}
      {(dryRun.isError || finalize.isError) && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(finalize.error ?? dryRun.error, t("errors.generic"))}
        </p>
      )}
      <div className="dialog__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={finalize.isPending || !dryRun.data}
          onClick={() => {
            if (sending.current) return;
            sending.current = true;
            finalize.mutate();
          }}
        >
          {t("awards.finalize.confirm")}
        </button>
        <button type="button" className="btn" data-autofocus onClick={onClose} disabled={finalize.isPending}>
          {t("awards.cancel")}
        </button>
      </div>
    </Modal>
  );
}
