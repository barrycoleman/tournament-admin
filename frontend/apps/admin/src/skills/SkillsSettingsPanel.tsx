import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { EventRead, SkillsSettingsRead } from "../types";
import { AttemptsInputs } from "./AttemptsInputs";
import { attemptsErrors, parseAttempts, toSkillsDraft, type SkillsSettingsDraft } from "./skillsSettingsDraft";
import { SKILLS_SETTINGS_KEY, useSkillsSettings } from "./useSkillsSettings";

/** Event Setup's "Skills challenges" panel: shown disabled, with the reason, until the game has skills types. */
export function SkillsSettingsPanel() {
  const { t } = useTranslation();
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const { data: settings } = useSkillsSettings();
  if (!event || !settings) return null;
  const disabledReason =
    event.game_plugin_name === null
      ? t("skills.settings.noPlugin")
      : settings.types.length === 0
        ? t("skills.settings.noTypes")
        : null;
  // Remount (and re-seed the draft) when the plugin or its types change.
  const formKey = `${event.game_plugin_name ?? ""}:${settings.types.map((type) => type.key).join(",")}`;
  return <SkillsSettingsForm key={formKey} settings={settings} disabledReason={disabledReason} />;
}

function SkillsSettingsForm({
  settings,
  disabledReason,
}: {
  settings: SkillsSettingsRead;
  disabledReason: string | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SkillsSettingsDraft>(() => toSkillsDraft(settings));
  const [attempted, setAttempted] = useState(false);
  const errors = attemptsErrors(draft.attempts);
  const disabled = disabledReason !== null;
  const mutation = useMutation({
    mutationFn: (body: { enabled: boolean; attempts: Record<string, number> }) =>
      apiRequest<SkillsSettingsRead>("/api/skills/settings", { method: "PUT", body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(SKILLS_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: ["sessionSkills"] });
      queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
    },
  });

  function update(changes: Partial<SkillsSettingsDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
    mutation.reset();
  }

  function onSubmit(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setAttempted(true);
    const attempts = parseAttempts(draft.attempts);
    if (attempts === null) return;
    mutation.mutate({ enabled: draft.enabled, attempts });
  }

  return (
    <section className="panel" aria-labelledby="skills-settings-heading">
      <h2 id="skills-settings-heading">{t("skills.settings.heading")}</h2>
      {disabledReason && (
        <p className="field__hint" id="skills-settings-reason">
          {disabledReason}
        </p>
      )}
      <form onSubmit={onSubmit} noValidate>
        <fieldset
          className="settings-group"
          disabled={disabled}
          aria-describedby={disabled ? "skills-settings-reason" : undefined}
        >
          <label className="choice">
            <input
              type="checkbox"
              role="switch"
              checked={draft.enabled}
              onChange={(changeEvent) => update({ enabled: changeEvent.target.checked })}
            />
            {t("skills.settings.enabledLabel")}
          </label>
          {settings.types.length > 0 && <p className="field__hint">{t("skills.settings.attemptsLegend")}</p>}
          <AttemptsInputs
            types={settings.types}
            values={draft.attempts}
            invalidKeys={attempted ? errors : new Set()}
            onChange={(key, text) => update({ attempts: { ...draft.attempts, [key]: text } })}
          />
          {mutation.isError && (
            <p className="alert alert-danger" role="alert">
              {apiErrorMessage(mutation.error, t("errors.generic"))}
            </p>
          )}
          {mutation.isSuccess && (
            <p className="alert alert-success" role="status">
              {t("skills.settings.saved")}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
              {t("skills.settings.save")}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
