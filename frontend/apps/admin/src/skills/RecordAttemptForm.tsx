import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, defaultValues, ScoresheetForm, type ScoresheetValues } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../types";
import { attemptStatus } from "./recordForm";
import { splitViolations } from "./scoresheetErrors";
import { TeamPicker } from "./TeamPicker";
import { skillsAttemptsKey, useSkillsSchema } from "./useSessionSkills";
import { useScoresheetT } from "./useScoresheetT";

interface RecordBody {
  team_id: number;
  skills_type: string;
  data: ScoresheetValues;
}

export function RecordAttemptForm({
  sessionId,
  types,
  teams,
  attempts,
}: {
  sessionId: number;
  types: SessionSkillsType[];
  /** The session's checked-in teams. */
  teams: TeamSummary[];
  attempts: SkillsAttemptRead[];
}) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const inFlight = useRef(false);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [typeKey, setTypeKey] = useState<string | null>(types[0]?.key ?? null);
  const [values, setValues] = useState<ScoresheetValues | null>(null);
  const [savedScore, setSavedScore] = useState<number | null>(null);
  const type = types.find((candidate) => candidate.key === typeKey) ?? types[0] ?? null;
  const schema = useSkillsSchema(type?.key ?? null);
  const fields = schema.data ?? [];
  const current = values ?? defaultValues(fields);
  const team = teams.find((candidate) => candidate.id === teamId) ?? null;
  const status = team && type ? attemptStatus(attempts, team.id, type.key, type.allowed) : null;

  const mutation = useMutation({
    mutationFn: (body: RecordBody) =>
      apiRequest<SkillsAttemptRead>(`/api/sessions/${sessionId}/skills/attempts`, { method: "POST", body }),
    onSuccess: (saved) => {
      setSavedScore(saved.score);
      setValues(null);
      queryClient.invalidateQueries({ queryKey: skillsAttemptsKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const split = splitViolations(
    mutation.error,
    fields.map((field) => field.name)
  );

  function resetFeedback() {
    setSavedScore(null);
    mutation.reset();
  }

  function save() {
    if (!team || !type || inFlight.current) return;
    inFlight.current = true;
    mutation.mutate({ team_id: team.id, skills_type: type.key, data: current });
  }

  const usedUpId = `${headingId}-used-up`;
  const canSave = team !== null && type !== null && schema.data !== undefined && status !== null && !status.usedUp;

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("skills.record.heading")}</h2>
      <TeamPicker
        teams={teams}
        selectedId={teamId}
        onSelect={(id) => {
          setTeamId(id);
          setValues(null);
          resetFeedback();
        }}
      />
      {types.length > 1 && (
        <div className="skills-type-buttons" role="group" aria-label={t("skills.record.typeLegend")}>
          {types.map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              className={candidate.key === type?.key ? "btn btn-primary" : "btn"}
              aria-pressed={candidate.key === type?.key}
              onClick={() => {
                setTypeKey(candidate.key);
                setValues(null);
                resetFeedback();
              }}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}
      {!team && <p className="field__hint">{t("skills.record.pickTeam")}</p>}
      {team && type && status && status.usedUp && (
        <p className="alert alert-warning" id={usedUpId}>
          {t("skills.record.usedUp", { number: team.number, n: type.allowed, label: type.label })}
        </p>
      )}
      {team && type && status && !status.usedUp && (
        <p className="skills-record__count">{t("skills.record.attemptCount", { n: status.next, allowed: type.allowed })}</p>
      )}
      {fields.length > 0 && (
        <ScoresheetForm
          fields={fields}
          values={current}
          errors={split?.byField ?? {}}
          t={scoresheetT}
          idPrefix={`${headingId}-sheet`}
          onChange={(next) => {
            setValues(next);
            resetFeedback();
          }}
        />
      )}
      {mutation.isError && (!split || split.other.length > 0) && (
        <p className="alert alert-danger" role="alert">
          {split ? split.other.join(" ") : apiErrorMessage(mutation.error, t("errors.generic"))}
        </p>
      )}
      {savedScore !== null && (
        <p className="alert alert-success" role="status">
          {t("skills.record.saved", { score: savedScore })}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave || mutation.isPending}
          aria-describedby={status?.usedUp ? usedUpId : undefined}
          onClick={save}
        >
          {t("skills.record.save")}
        </button>
      </div>
    </section>
  );
}
