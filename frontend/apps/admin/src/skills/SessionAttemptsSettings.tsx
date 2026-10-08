import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { SessionSkillsRead } from "../types";
import { AttemptsInputs } from "./AttemptsInputs";
import { attemptsErrors, parseAttempts } from "./skillsSettingsDraft";
import { sessionSkillsKey } from "./useSessionSkills";

/** "Autonomous 3 · Driver 3 (event setting)", with Change for this session and Use event setting. */
export function SessionAttemptsSettings({ sessionId, skills }: { sessionId: number; skills: SessionSkillsRead }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formId = useId();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation({
    mutationFn: (attempts: Record<string, number> | null) =>
      apiRequest<SessionSkillsRead>(`/api/sessions/${sessionId}/skills`, { method: "PUT", body: { attempts } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(sessionSkillsKey(sessionId), saved);
      queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
      setDraft(null);
    },
  });
  const entries = skills.types
    .map((type) => t("skills.page.attemptsEntry", { label: type.label, allowed: type.allowed }))
    .join(" · ");
  const source = t(skills.override ? "skills.page.sourceSession" : "skills.page.sourceEvent");
  const errors = draft ? attemptsErrors(draft) : new Set<string>();

  function startEditing() {
    setDraft(Object.fromEntries(skills.types.map((type) => [type.key, String(type.allowed)])));
    setAttempted(false);
    mutation.reset();
  }

  function onSubmit(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setAttempted(true);
    const parsed = draft ? parseAttempts(draft) : null;
    if (parsed) mutation.mutate(parsed);
  }

  return (
    <section className="skills-attempts-line" aria-label={t("skills.page.attemptsHeading")}>
      <p>{t("skills.page.attemptsLine", { entries, source })}</p>
      {draft === null ? (
        <>
          <button type="button" className="btn btn-small" onClick={startEditing}>
            {t("skills.page.change")}
          </button>
          {skills.override && (
            <button
              type="button"
              className="btn btn-small"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(null)}
            >
              {t("skills.page.useEvent")}
            </button>
          )}
        </>
      ) : (
        <form className="skills-override" onSubmit={onSubmit} noValidate>
          <fieldset className="settings-group">
            <legend>{t("skills.page.overrideLegend")}</legend>
            <AttemptsInputs
              types={skills.types}
              values={draft}
              invalidKeys={attempted ? errors : new Set()}
              idPrefix={`${formId}-override`}
              onChange={(key, text) => {
                setDraft({ ...draft, [key]: text });
                mutation.reset();
              }}
            />
          </fieldset>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
              {t("skills.page.overrideSave")}
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              {t("skills.page.overrideCancel")}
            </button>
          </div>
        </form>
      )}
      {mutation.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(mutation.error, t("errors.generic"))}
        </p>
      )}
    </section>
  );
}
