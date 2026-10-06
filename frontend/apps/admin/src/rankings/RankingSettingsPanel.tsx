import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { RankingSettingsRead, RankingSettingsValues, SessionDropMode } from "../types";
import { draftErrors, toBody, toDraft, type SettingsDraft } from "./settingsDraft";
import { RANKING_SETTINGS_KEY, useRankingSettings } from "./useRankingSettings";

/** Event Setup's ranking settings. Only cooperative games have any. */
export function RankingSettingsPanel() {
  const { data } = useRankingSettings();
  if (!data || data.game_model !== "cooperative_score") return null;
  return <RankingSettingsForm initial={data} />;
}

const MODES: { value: SessionDropMode; labelKey: string }[] = [
  { value: "tiered", labelKey: "rankings.settings.modeTiered" },
  { value: "none", labelKey: "rankings.settings.modeNone" },
  { value: "lowest", labelKey: "rankings.settings.modeLowest" },
];

function RankingSettingsForm({ initial }: { initial: RankingSettingsRead }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(initial));
  const [attempted, setAttempted] = useState(false);
  const errors = draftErrors(draft);
  const mutation = useMutation({
    mutationFn: (body: RankingSettingsValues) =>
      apiRequest<RankingSettingsRead>("/api/ranking-settings", { method: "PUT", body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(RANKING_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: ["rankings"] });
    },
  });

  function update(changes: Partial<SettingsDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
    mutation.reset();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate(toBody(draft));
  }

  function fieldError(field: keyof typeof errors) {
    const key = attempted ? errors[field] : undefined;
    return key ? (
      <p className="field__hint field__error" id={`ranking-${field}-error`}>
        {t(`rankings.settings.errors.${key}`)}
      </p>
    ) : null;
  }

  return (
    <section className="panel" aria-labelledby="ranking-settings-heading">
      <h2 id="ranking-settings-heading">{t("rankings.settings.heading")}</h2>
      <p className="field__hint">{t("rankings.settings.intro")}</p>
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="settings-group">
          <legend>{t("rankings.settings.sessionLegend")}</legend>
          {MODES.map((mode) => (
            <div key={mode.value}>
              <label className="choice">
                <input
                  type="radio"
                  name="session-drop-mode"
                  value={mode.value}
                  checked={draft.mode === mode.value}
                  onChange={() => update({ mode: mode.value })}
                />
                {t(mode.labelKey)}
              </label>
              {mode.value === "tiered" && <p className="field__hint">{t("rankings.settings.tieredHint")}</p>}
            </div>
          ))}
          <div className="field">
            <label className="field__label" htmlFor="ranking-drop-count">
              {t("rankings.settings.dropCountLabel")}
            </label>
            <input
              id="ranking-drop-count"
              className="input settings-number"
              inputMode="numeric"
              value={draft.dropCount}
              disabled={draft.mode !== "lowest"}
              aria-invalid={attempted && errors.dropCount ? true : undefined}
              aria-describedby={attempted && errors.dropCount ? "ranking-dropCount-error" : undefined}
              onChange={(event) => update({ dropCount: event.target.value })}
            />
            {fieldError("dropCount")}
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.sessionNoShow}
              onChange={(event) => update({ sessionNoShow: event.target.checked })}
            />
            {t("rankings.settings.noShowLabel")}
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.sessionDq}
              onChange={(event) => update({ sessionDq: event.target.checked })}
            />
            {t("rankings.settings.dqLabel")}
          </label>
        </fieldset>

        <fieldset className="settings-group">
          <legend>{t("rankings.settings.seasonLegend")}</legend>
          <div className="field">
            <label className="field__label" htmlFor="ranking-keep-best">
              {t("rankings.settings.keepBestLabel")}
            </label>
            <input
              id="ranking-keep-best"
              className="input settings-number"
              inputMode="numeric"
              value={draft.keepBest}
              aria-invalid={attempted && errors.keepBest ? true : undefined}
              aria-describedby={attempted && errors.keepBest ? "ranking-keepBest-error" : "ranking-keep-best-hint"}
              onChange={(event) => update({ keepBest: event.target.value })}
            />
            <p className="field__hint" id="ranking-keep-best-hint">
              {t("rankings.settings.keepBestHint")}
            </p>
            {fieldError("keepBest")}
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.onlySessionCounted}
              onChange={(event) => update({ onlySessionCounted: event.target.checked })}
            />
            {t("rankings.settings.onlySessionCountedLabel")}
          </label>
          <div className="field">
            <label className="field__label" htmlFor="ranking-minimum">
              {t("rankings.settings.minimumLabel")}
            </label>
            <input
              id="ranking-minimum"
              className="input settings-number"
              inputMode="numeric"
              value={draft.minimum}
              aria-invalid={attempted && errors.minimum ? true : undefined}
              aria-describedby={attempted && errors.minimum ? "ranking-minimum-error" : "ranking-minimum-hint"}
              onChange={(event) => update({ minimum: event.target.value })}
            />
            <p className="field__hint" id="ranking-minimum-hint">
              {t("rankings.settings.minimumHint")}
            </p>
            {fieldError("minimum")}
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.seasonNoShow}
              onChange={(event) => update({ seasonNoShow: event.target.checked })}
            />
            {t("rankings.settings.noShowLabel")}
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.seasonDq}
              onChange={(event) => update({ seasonDq: event.target.checked })}
            />
            {t("rankings.settings.dqLabel")}
          </label>
        </fieldset>

        {mutation.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(mutation.error, t("errors.generic"))}
          </p>
        )}
        {mutation.isSuccess && (
          <p className="alert alert-success" role="status">
            {t("rankings.settings.saved")}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {t("rankings.settings.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
