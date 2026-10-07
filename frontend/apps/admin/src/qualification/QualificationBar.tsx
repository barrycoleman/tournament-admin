import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import type { SessionRead } from "../types";
import { FinalizeDialog } from "./FinalizeDialog";
import { qualificationPreviewKey, useQualificationPreview } from "./useQualificationPreview";

/** The Matches page's qualification status: Finalize (or why not yet), or finalized with Reopen. */
export function QualificationBar({ session }: { session: SessionRead }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const blockersId = useId();
  const { data: preview, error: previewError, refetch } = useQualificationPreview(session.id);
  const [dialog, setDialog] = useState<"finalize" | "reopen" | null>(null);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["matches", session.id] });
    queryClient.invalidateQueries({ queryKey: qualificationPreviewKey(session.id) });
    queryClient.invalidateQueries({ queryKey: ["rankings"] });
  }

  const reopen = useMutation({
    mutationFn: () =>
      apiRequest<SessionRead>(`/api/sessions/${session.id}/qualification/reopen`, { method: "POST" }),
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
    // A failed reopen may have partly committed; refetch so the bar is not stale.
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: qualificationPreviewKey(session.id) });
    },
  });

  if (session.qualification_finalized_at) {
    const formatted = new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: session.timezone ?? "UTC",
    }).format(new Date(session.qualification_finalized_at));
    const date = session.timezone ? formatted : `${formatted} UTC`;
    return (
      <div className="qualification-bar">
        <p className="qualification-bar__status">{t("sessions.qualification.finalizedOn", { date })}</p>
        <button type="button" className="btn" onClick={() => setDialog("reopen")}>
          {t("sessions.qualification.reopen")}
        </button>
        {dialog === "reopen" && (
          <ConfirmDialog
            heading={t("sessions.qualification.reopenHeading")}
            body={t("sessions.qualification.reopenBody")}
            confirmLabel={t("sessions.qualification.reopen")}
            cancelLabel={t("sessions.qualification.cancel")}
            isPending={reopen.isPending}
            error={reopen.error ? apiErrorMessage(reopen.error, t("sessions.qualification.genericError")) : null}
            onConfirm={() => reopen.mutate()}
            onCancel={() => {
              setDialog(null);
              reopen.reset();
            }}
          />
        )}
      </div>
    );
  }

  const blockers = preview?.blockers ?? [];
  return (
    <div className="qualification-bar">
      <button
        type="button"
        className="btn btn-primary"
        disabled={!preview || blockers.length > 0}
        aria-describedby={blockers.length ? blockersId : undefined}
        onClick={() => setDialog("finalize")}
      >
        {t("sessions.qualification.finalize")}
      </button>
      {previewError && (
        <>
          <p className="alert alert-danger qualification-bar__status" role="alert">
            {apiErrorMessage(previewError, t("sessions.qualification.genericError"))}
          </p>
          <button type="button" className="btn" onClick={() => refetch()}>
            {t("sessions.qualification.retry")}
          </button>
        </>
      )}
      {blockers.length > 0 && (
        <ul id={blockersId} className="qualification-bar__blockers">
          {blockers.map((blocker) => (
            <li key={blocker.code}>{t(`sessions.qualification.blocker.${blocker.code}`, { count: blocker.count })}</li>
          ))}
        </ul>
      )}
      {dialog === "finalize" && preview && (
        <FinalizeDialog
          sessionId={session.id}
          preview={preview}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
