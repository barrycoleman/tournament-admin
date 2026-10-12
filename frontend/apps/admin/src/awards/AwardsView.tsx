import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import { useGamePlugin } from "../gamePlugin/useGamePlugin";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { AwardRead, AwardSlotRead, Division, SessionRead, SlotStatus } from "../types";
import { AwardFormDialog } from "./AwardFormDialog";
import { ruleSummary } from "./awardForm";
import { downloadAwardsCsv } from "./downloadCsv";
import { AWARD_REFRESH_EVENTS, awardsKey, teamHistoryKey, useSessionAwards } from "./useAwards";

export type AwardsMode = "admin" | "judge";

const BADGE_CLASS: Record<SlotStatus, string> = {
  judged_pending: "badge badge-neutral",
  judged: "badge badge-success",
  resolved: "badge badge-success",
  provisional: "badge badge-warning",
  no_result: "badge badge-neutral",
  overridden: "badge badge-warning",
  finalized: "badge badge-success",
};

/** Renders a slot's extra controls; Task 7 supplies them. */
export type SlotActions = (award: AwardRead, slot: AwardSlotRead, locked: boolean) => ReactNode;

export function AwardsView({
  session,
  mode,
  channelPath,
  slotActions,
  finalizeControl,
}: {
  session: SessionRead;
  mode: AwardsMode;
  channelPath: string;
  slotActions?: SlotActions;
  finalizeControl?: (locked: boolean) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const awardsQuery = useSessionAwards(session.id);
  const skills = useSkillsSettings();
  const plugin = useGamePlugin();
  const divisions = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const [editing, setEditing] = useState<AwardRead | "new" | null>(null);
  const [deleting, setDeleting] = useState<AwardRead | null>(null);
  const [copying, setCopying] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: awardsKey(session.id) });
    queryClient.invalidateQueries({ queryKey: teamHistoryKey(session.id) });
  };
  useRealtimeChannel({
    path: channelPath,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (AWARD_REFRESH_EVENTS.has(realtimeEvent.event)) refresh();
    },
  });

  const reorder = useMutation({
    mutationFn: (ids: number[]) =>
      apiRequest(`/api/sessions/${session.id}/awards/order`, { method: "PUT", body: { award_ids: ids } }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest(`/api/awards/${id}`, { method: "DELETE" }),
    onSuccess: () => setDeleting(null),
    onSettled: refresh,
  });
  const unfinalize = useMutation({
    mutationFn: () => apiRequest(`/api/sessions/${session.id}/awards/unfinalize`, { method: "POST" }),
    onSettled: refresh,
  });

  if (awardsQuery.isLoading) return <p>{t("awards.loading")}</p>;
  if (awardsQuery.isError || !awardsQuery.data) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }

  const data = awardsQuery.data;
  const locked = data.awards_finalized_at !== null;
  const isAdmin = mode === "admin";
  const shown = isAdmin ? data.awards : data.awards.filter((a) => a.kind === "judged");
  const typeLabels = Object.fromEntries((skills.data?.types ?? []).map((type) => [type.key, type.label]));
  const ids = data.awards.map((a) => a.id);

  function move(index: number, delta: number) {
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    queryClient.setQueryData(awardsKey(session.id), {
      ...data,
      awards: next.map((id) => data.awards.find((a) => a.id === id)!),
    });
    reorder.mutate(next);
  }

  return (
    <div className="awards">
      {isAdmin && (
        <div className="toolbar">
          <button type="button" className="btn btn-primary" disabled={locked} onClick={() => setEditing("new")}>
            {t("awards.addAction")}
          </button>
          <button type="button" className="btn" disabled={locked} onClick={() => setCopying(true)}>
            {t("awards.copyAction")}
          </button>
          <button type="button" className="btn" onClick={() => {
              setExportError(null);
              downloadAwardsCsv(session.id).catch(setExportError);
            }}>
            {t("awards.exportAction")}
          </button>
          <span className="toolbar__spacer" />
          {locked ? (
            <button type="button" className="btn" onClick={() => unfinalize.mutate()} disabled={unfinalize.isPending}>
              {t("awards.unfinalizeAction")}
            </button>
          ) : (
            finalizeControl?.(locked)
          )}
        </div>
      )}
      {locked && (
        <p className="alert alert-success" role="status">
          {t("awards.finalizedBanner", {
            date: new Date(data.awards_finalized_at!).toLocaleString(i18n.language),
          })}
        </p>
      )}
      {exportError !== null && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(exportError, t("errors.generic"))}
        </p>
      )}
      {(reorder.isError || unfinalize.isError) && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(reorder.error ?? unfinalize.error, t("errors.generic"))}
        </p>
      )}
      {shown.length === 0 && <p>{t(isAdmin ? "awards.empty" : "awards.judgeEmpty")}</p>}
      {shown.map((award) => {
        const index = ids.indexOf(award.id);
        return (
          <article key={award.id} className="panel award-card" aria-labelledby={`award-${award.id}`}>
            <div className="award-card__header">
              <h2 id={`award-${award.id}`}>{award.name}</h2>
              {isAdmin && (
                <div className="award-card__actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    aria-label={t("awards.moveUp", { name: award.name })}
                    disabled={locked || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    aria-label={t("awards.moveDown", { name: award.name })}
                    disabled={locked || index === ids.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className="btn btn-small" disabled={locked} onClick={() => setEditing(award)}>
                    {t("awards.editAction")}
                  </button>
                  <button type="button" className="btn btn-small btn-danger" disabled={locked} onClick={() => setDeleting(award)}>
                    {t("awards.deleteAction")}
                  </button>
                </div>
              )}
            </div>
            {award.description && <p>{award.description}</p>}
            <p className="field__hint">{ruleSummary(t, award, typeLabels)}</p>
            <ul className="list-plain" aria-label={t("awards.slotsLabel", { name: award.name })}>
              {award.slots.map((slot) => (
                <li key={slot.division_id ?? "event"} className="list-row">
                  <span className="list-row__main">
                    <strong>{slot.division_name ?? t("awards.eventSlot")}</strong>{" "}
                    {slot.winners.length === 0
                      ? t("awards.noWinner")
                      : slot.winners.map((w) => `${w.number} ${w.name}`).join(", ")}
                  </span>
                  <span className={BADGE_CLASS[slot.status]}>{t(`awards.status.${slot.status}`)}</span>
                  {slot.note && <span className="list-row__meta">{t(`awards.note.${slot.note}`)}</span>}
                  {slot.override_reason && (
                    <span className="list-row__meta">{t("awards.overrideReason", { reason: slot.override_reason })}</span>
                  )}
                  {slot.moved_team_ids.map((teamId) => (
                    <span key={teamId} className="list-row__meta">
                      {t("awards.movedWarning", {
                        number: slot.winners.find((w) => w.team_id === teamId)?.number ?? teamId,
                      })}
                    </span>
                  ))}
                  {slotActions?.(award, slot, locked)}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
      {editing !== null && (
        <AwardFormDialog
          sessionId={session.id}
          award={editing === "new" ? null : editing}
          divisions={divisions.data ?? []}
          skillsTypes={skills.data?.types ?? []}
          availability={{ pluginSelected: plugin.selected, skillsEnabled: Boolean(skills.data?.enabled) }}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          heading={t("awards.deleteHeading", { name: deleting.name })}
          body={t("awards.deleteBody")}
          confirmLabel={t("awards.deleteConfirm")}
          cancelLabel={t("awards.cancel")}
          isPending={remove.isPending}
          error={remove.isError ? apiErrorMessage(remove.error, t("errors.generic")) : null}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {copying && <CopyAwardsDialog sessionId={session.id} onClose={() => setCopying(false)} onDone={refresh} />}
    </div>
  );
}

function CopyAwardsDialog({
  sessionId,
  onClose,
  onDone,
}: {
  sessionId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const others = (sessions.data ?? []).filter((s) => s.id !== sessionId);
  const [fromId, setFromId] = useState<number | null>(null);
  const copy = useMutation({
    mutationFn: (from: number) =>
      apiRequest(`/api/sessions/${sessionId}/awards/copy`, { method: "POST", body: { from_session_id: from } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal labelledBy="copy-awards-heading" onCancel={() => !copy.isPending && onClose()}>
      <h2 id="copy-awards-heading">{t("awards.copyHeading")}</h2>
      <label className="field">
        <span className="field__label">{t("awards.copyFromLabel")}</span>
        <select
          className="input"
          data-autofocus
          value={fromId ?? ""}
          onChange={(e) => setFromId(e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="" />
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {copy.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(copy.error, t("errors.generic"))}
        </p>
      )}
      <div className="dialog__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={fromId === null || copy.isPending}
          onClick={() => fromId !== null && copy.mutate(fromId)}
        >
          {t("awards.copyConfirm")}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={copy.isPending}>
          {t("awards.cancel")}
        </button>
      </div>
    </Modal>
  );
}
