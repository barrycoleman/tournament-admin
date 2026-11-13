import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiRequest, type LiveMatch } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { Modal } from "../components/Modal";
import { useDisplays, type UnplacedDisplay } from "../displays/useDisplays";
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
  // TVs the copy couldn't place: shown after activating instead of closing.
  const [unplaced, setUnplaced] = useState<UnplacedDisplay[] | null>(null);

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

  // Hold the actions until everything that shapes them has settled, so a
  // click can't skip the copy offer or the running-match warning. A cached
  // answer from an earlier opening doesn't count while it is being refetched.
  const settling =
    event.isLoading ||
    sessions.isLoading ||
    matches.isFetching ||
    targetDisplays.isFetching ||
    sourceDisplays.isFetching;

  const activate = useMutation({
    mutationFn: async (copyFrom: number | null) => {
      let notPlaced: UnplacedDisplay[] = [];
      if (copyFrom !== null) {
        const copied = await apiRequest<{ unplaced: UnplacedDisplay[] }>(
          `/api/sessions/${targetSession.id}/copy-displays`,
          { method: "POST", body: { source_session_id: copyFrom } }
        );
        notPlaced = copied?.unplaced ?? [];
      }
      await apiRequest<EventRead>("/api/event/active-session", {
        method: "POST",
        body: { session_id: targetSession.id },
      });
      return notPlaced;
    },
    onSuccess: async (notPlaced) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["event"] }),
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      ]);
      if (notPlaced.length > 0) setUnplaced(notPlaced);
      else onActivated?.();
    },
    onError: (err) => setError(apiErrorMessage(err, t("errors.generic"))),
    // Even after a failed activation the copy may have landed, so refetch the
    // spots: a retry then won't offer a copy the server would refuse.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["displays"] }),
  });

  const busy = activate.isPending || settling;

  const run = (copyFrom: number | null) => {
    setError(null);
    activate.mutate(copyFrom);
  };

  if (unplaced) {
    return (
      <Modal labelledBy={headingId} onCancel={onClose}>
        <h2 id={headingId}>{t("orientation.makeActive.heading", { label: targetSession.label })}</h2>
        <div className="alert alert-warning" role="status">
          <p>{t("orientation.makeActive.unplacedHeading", { label: targetSession.label })}</p>
          <ul>
            {unplaced.map((u) => (
              <li key={u.device_id}>{t("displays.unplacedItem", { name: u.device_name, group: u.source_group_name })}</li>
            ))}
          </ul>
          <p>
            <Link to="/devices" onClick={onClose}>
              {t("orientation.makeActive.unplacedLink")}
            </Link>
          </p>
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            {t("orientation.makeActive.closeAction")}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal labelledBy={headingId} onCancel={() => !activate.isPending && onClose()}>
      <h2 id={headingId}>{t("orientation.makeActive.heading", { label: targetSession.label })}</h2>
      <p>{t("orientation.makeActive.body", { label: targetSession.label })}</p>
      {running && (
        <p className="alert alert-warning" role="alert">
          {t("orientation.makeActive.runningMatch", { match: running.label, activeLabel })}
        </p>
      )}
      {matches.isError && !matches.isFetching && (
        <p className="alert alert-warning" role="alert">
          {t("orientation.makeActive.matchCheckFailed", { label: activeLabel })}
        </p>
      )}
      {settling && <p>{t("orientation.makeActive.loading")}</p>}
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
              disabled={busy}
              onClick={() => run(activeId)}
            >
              {t("orientation.makeActive.copyAndActivateAction")}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => run(null)}>
              {t("orientation.makeActive.activateWithoutCopyingAction")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
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
    dialog: target ? (
      <MakeActiveDialog
        targetSession={target}
        onClose={() => setTarget(null)}
        onActivated={() => setTarget(null)}
      />
    ) : null,
  };
}
