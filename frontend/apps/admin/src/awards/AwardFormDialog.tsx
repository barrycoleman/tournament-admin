import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import type { AwardRead, AwardSource, Division } from "../types";
import {
  availableSources,
  draftError,
  draftFromAward,
  draftToBody,
  emptyDraft,
  performanceBlockedReason,
  ruleChanged,
  type SourceAvailability,
  type AwardDraft,
} from "./awardForm";
import { awardsKey, teamHistoryKey } from "./useAwards";

const SOURCE_LABEL_KEYS: Record<AwardSource, string> = {
  teamwork_ranking: "awards.source.teamworkRanking",
  finals: "awards.source.finals",
  skills_overall: "awards.source.skillsOverall",
  skills_type: "awards.source.skillsType",
};

/** Add (award = null) or edit an award. */
export function AwardFormDialog({
  sessionId,
  award,
  divisions,
  skillsTypes,
  availability,
  onClose,
}: {
  sessionId: number;
  award: AwardRead | null;
  divisions: Division[];
  skillsTypes: { key: string; label: string }[];
  availability: SourceAvailability;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AwardDraft>(award ? draftFromAward(award) : emptyDraft());
  const [submitted, setSubmitted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const set = (patch: Partial<AwardDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = draftToBody(draft);
      return award
        ? apiRequest(`/api/awards/${award.id}`, { method: "PATCH", body })
        : apiRequest(`/api/sessions/${sessionId}/awards`, { method: "POST", body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: awardsKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: teamHistoryKey(sessionId) });
      onClose();
    },
  });

  const error = draftError(draft);
  const hasWinners = award?.slots.some((slot) => slot.status === "judged" || slot.status === "overridden");
  const showRuleWarning = award !== null && hasWinners && ruleChanged(award, draftToBody(draft));
  const originalSource = award?.kind === "performance" ? award.source : null;
  const originalKind = award?.kind ?? null;
  const sources = availableSources(draft.scope, availability);
  const keptSource: AwardSource | null =
    originalSource !== null && !sources.includes(originalSource) && draft.scope === award?.scope ? originalSource : null;
  const blockedReason = performanceBlockedReason(draft.scope, availability);
  const performanceDisabled = blockedReason !== null && originalKind !== "performance";
  const keptSkillsType =
    award?.skills_type && !skillsTypes.some((type) => type.key === award.skills_type) ? award.skills_type : null;

  return (
    <Modal labelledBy={headingId} onCancel={() => !save.isPending && onClose()}>
      <form
        className="panel--form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (error !== null || save.isPending) return;
          if (showRuleWarning) setConfirming(true);
          else save.mutate();
        }}
      >
        <h2 id={headingId}>{t(award ? "awards.form.editHeading" : "awards.form.addHeading")}</h2>
        <label className="field">
          <span className="field__label">{t("awards.form.nameLabel")}</span>
          <input className="input" value={draft.name} maxLength={200} data-autofocus onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label">{t("awards.form.descriptionLabel")}</span>
          <textarea
            className="input"
            value={draft.description}
            maxLength={2000}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <fieldset className="field">
          <legend className="field__label">{t("awards.form.kindLabel")}</legend>
          {(["judged", "performance"] as const).map((kind) => (
            <label key={kind}>
              <input
                type="radio"
                name="kind"
                checked={draft.kind === kind}
                disabled={kind === "performance" && performanceDisabled}
                onChange={() => set({ kind })}
              />{" "}
              {t(kind === "judged" ? "awards.form.kindJudged" : "awards.form.kindPerformance")}
            </label>
          ))}
          {blockedReason !== null && <p className="field__hint">{t(blockedReason)}</p>}
        </fieldset>
        <fieldset className="field">
          <legend className="field__label">{t("awards.form.scopeLabel")}</legend>
          {(["event", "division"] as const).map((scope) => (
            <label key={scope}>
              <input
                type="radio"
                name="scope"
                checked={draft.scope === scope}
                onChange={() => {
                  const options = availableSources(scope, availability);
                  const keep = options.includes(draft.source) || (originalSource === draft.source && scope === award?.scope);
                  const patch: Partial<AwardDraft> = { scope, source: keep ? draft.source : (options[0] ?? draft.source) };
                  if (draft.kind === "performance" && originalKind !== "performance" && performanceBlockedReason(scope, availability) !== null) {
                    patch.kind = "judged";
                  }
                  set(patch);
                }}
              />{" "}
              {t(scope === "event" ? "awards.form.scopeEvent" : "awards.form.scopeDivision")}
            </label>
          ))}
          {draft.scope === "division" && divisions.length > 1 && (
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={draft.allDivisions}
                  onChange={(e) => set({ allDivisions: e.target.checked })}
                />{" "}
                {t("awards.form.allDivisions")}
              </label>
              {!draft.allDivisions &&
                divisions.map((division) => (
                  <label key={division.id}>
                    <input
                      type="checkbox"
                      checked={draft.divisionIds.includes(division.id)}
                      onChange={(e) =>
                        set({
                          divisionIds: e.target.checked
                            ? [...draft.divisionIds, division.id]
                            : draft.divisionIds.filter((id) => id !== division.id),
                        })
                      }
                    />{" "}
                    {division.name}
                  </label>
                ))}
            </div>
          )}
        </fieldset>
        {draft.kind === "performance" && (
          <>
            <label className="field">
              <span className="field__label">{t("awards.form.sourceLabel")}</span>
              <select
                className="input"
                value={draft.source}
                onChange={(e) => set({ source: e.target.value as AwardSource })}
              >
                {sources.map((source) => (
                  <option key={source} value={source}>
                    {t(SOURCE_LABEL_KEYS[source])}
                  </option>
                ))}
                {keptSource !== null && (
                  <option value={keptSource}>
                    {t("awards.form.notAvailable", { label: t(SOURCE_LABEL_KEYS[keptSource]) })}
                  </option>
                )}
              </select>
            </label>
            {draft.source === "skills_type" && (
              <label className="field">
                <span className="field__label">{t("awards.form.skillsTypeLabel")}</span>
                <select className="input" value={draft.skillsType} onChange={(e) => set({ skillsType: e.target.value })}>
                  <option value="" />
                  {skillsTypes.map((type) => (
                    <option key={type.key} value={type.key}>
                      {type.label}
                    </option>
                  ))}
                  {keptSkillsType !== null && (
                    <option value={keptSkillsType}>{t("awards.form.notAvailable", { label: keptSkillsType })}</option>
                  )}
                </select>
              </label>
            )}
            {draft.source !== "finals" && (
              <label className="field">
                <span className="field__label">{t("awards.form.basisLabel")}</span>
                <select
                  className="input"
                  value={draft.basis}
                  onChange={(e) => set({ basis: e.target.value as AwardDraft["basis"] })}
                >
                  <option value="session">{t("awards.form.basisSession")}</option>
                  <option value="season">{t("awards.form.basisSeason")}</option>
                </select>
              </label>
            )}
            <label className="field">
              <span className="field__label">{t("awards.form.placementLabel")}</span>
              <input
                className="input"
                inputMode="numeric"
                value={draft.placement}
                onChange={(e) => set({ placement: e.target.value })}
              />
            </label>
          </>
        )}
        {showRuleWarning && (
          <p className="alert alert-warning" role="status">
            {t("awards.form.ruleChangeWarning")}
          </p>
        )}
        {submitted && error && (
          <p className="alert alert-danger" role="alert">
            {t(error)}
          </p>
        )}
        {save.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(save.error, t("errors.generic"))}
          </p>
        )}
        <div className="dialog__actions">
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {t("awards.form.save")}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>
            {t("awards.cancel")}
          </button>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog
          heading={t("awards.form.ruleChangeConfirmHeading", { name: draft.name.trim() })}
          body={t("awards.form.ruleChangeConfirmBody")}
          confirmLabel={t("awards.form.ruleChangeConfirm")}
          cancelLabel={t("awards.cancel")}
          isPending={save.isPending}
          error={save.isError ? apiErrorMessage(save.error, t("errors.generic")) : null}
          onConfirm={() => save.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Modal>
  );
}
