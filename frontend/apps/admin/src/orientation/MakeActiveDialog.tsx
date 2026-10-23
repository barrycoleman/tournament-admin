import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, type LiveMatch } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { Modal } from "../components/Modal";
import { useDisplays } from "../displays/useDisplays";
import type { EventRead, SessionRead } from "../types";
import { useEvent, useSessions } from "./useOrientationData";

interface MakeActiveDialogProps {
  targetSession: SessionRead;
  onClose: () => void;
  onActivated?: () => void;
}

const IDLE_PHASES = ["not_started", "ended"];

export function MakeActiveDialog({ targetSession, onClose, onActivated }: MakeActiveDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [error, setError] = useState<string | null>(null);

  const event = useEvent();
  const sessions = useSessions();
  const activeId = event.data?.active_session_id ?? null;
  const activeLabel = sessions.data?.find((s) => s.id === activeId)?.label ?? "";

  const matches = useQuery({
    queryKey: ["liveMatches", activeId],
    queryFn: () => apiRequest<LiveMatch[]>(`/api/matches?session_id=${activeId}`),
    enabled: activeId !== null,
  });
  const running = matches.data?.find((m) => !IDLE_PHASES.includes(m.phase));

  const targetDisplays = useDisplays(targetSession.id);
  const sourceDisplays = useDisplays(activeId);
  const offerCopy =
    activeId !== null &&
    activeId !== targetSession.id &&
    targetDisplays.data?.has_setup === false &&
    sourceDisplays.data?.has_setup === true;

  const activate = useMutation({
    mutationFn: async (copyFrom: number | null) => {
      if (copyFrom !== null) {
        await apiRequest(`/api/sessions/${targetSession.id}/copy-displays`, {
          method: "POST",
          body: { source_session_id: copyFrom },
        });
      }
      return apiRequest<EventRead>("/api/event/active-session", {
        method: "POST",
        body: { session_id: targetSession.id },
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["event"] }),
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["displays"] }),
      ]);
      onActivated?.();
    },
    onError: (err) => setError(apiErrorMessage(err, t("errors.generic"))),
  });

  const run = (copyFrom: number | null) => {
    setError(null);
    activate.mutate(copyFrom);
  };

  return (
    <Modal labelledBy={headingId} onCancel={() => !activate.isPending && onClose()}>
      <h2 id={headingId}>{t("orientation.makeActive.heading", { label: targetSession.label })}</h2>
      <p>{t("orientation.makeActive.body", { label: targetSession.label })}</p>
      {running && (
        <p className="alert alert-warning" role="alert">
          {t("orientation.makeActive.runningMatch", { match: running.label, activeLabel })}
        </p>
      )}
      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
      <div className="dialog__actions">
        {offerCopy ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={activate.isPending}
              onClick={() => run(activeId)}
            >
              {t("orientation.makeActive.copyAndActivateAction")}
            </button>
            <button type="button" className="btn" disabled={activate.isPending} onClick={() => run(null)}>
              {t("orientation.makeActive.activateWithoutCopyingAction")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={activate.isPending}
            onClick={() => run(null)}
          >
            {t("orientation.makeActive.activateAction")}
          </button>
        )}
        <button
          type="button"
          className="btn"
          data-autofocus
          disabled={activate.isPending}
          onClick={onClose}
        >
          {t("orientation.makeActive.cancelAction")}
        </button>
      </div>
    </Modal>
  );
}

/** Opens the dialog for a chosen session; render `dialog` once in the calling component. */
export function useMakeActive(): { open: (session: SessionRead) => void; dialog: ReactNode } {
  const [target, setTarget] = useState<SessionRead | null>(null);
  return {
    open: setTarget,
    dialog: target ? <MakeActiveDialog targetSession={target} onClose={() => setTarget(null)} onActivated={() => setTarget(null)} /> : null,
  };
}
