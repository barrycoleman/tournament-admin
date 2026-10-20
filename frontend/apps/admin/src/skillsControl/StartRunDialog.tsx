import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { Modal } from "../components/Modal";
import { useSkillsAttempts } from "../skills/useSessionSkills";
import type { ParticipationRead, SessionSkillsType, SkillsType, TeamSummary } from "../types";
import { eligibleTeams } from "./startRun";
import { skillsSetKey } from "./useSkillsControl";

/** Picks a team (and, rarely, another type) for an empty skills field. */
export function StartRunDialog({
  sessionId,
  fieldSetId,
  field,
  setType,
  types,
  sessionTypes,
  teams,
  busyTeamIds,
  onClose,
}: {
  sessionId: number;
  fieldSetId: number;
  field: { id: number; name: string };
  /** The set timer's type; a run of another type runs on its own timer. */
  setType: string | null;
  types: SkillsType[];
  sessionTypes: SessionSkillsType[];
  teams: TeamSummary[];
  busyTeamIds: Set<number>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const typeSelectId = useId();
  const teamSelectId = useId();
  const [skillsType, setSkillsType] = useState(setType ?? types[0]?.key ?? "");
  const [team, setTeam] = useState("");
  // Same keys as Check-In and the Skills page; mounting refetches them, so a
  // team checked in or an attempt used since the page loaded counts.
  const participants = useQuery({
    queryKey: ["participants", sessionId],
    queryFn: () => apiRequest<ParticipationRead[]>(`/api/sessions/${sessionId}/participants`),
  });
  const attempts = useSkillsAttempts(sessionId);
  const allowed = sessionTypes.find((type) => type.key === skillsType)?.allowed ?? 0;
  const loaded = participants.data !== undefined && attempts.data !== undefined;
  const options = loaded
    ? eligibleTeams({
        teams,
        participants: participants.data!,
        attempts: attempts.data!,
        skillsType,
        allowed,
        busyTeamIds,
      })
    : [];
  const followsSet = setType === null || skillsType === setType;
  const create = useMutation({
    mutationFn: () =>
      apiRequest(`/api/fields/${field.id}/skills-run`, {
        method: "POST",
        body: { team_id: Number(team), skills_type: skillsType, follows_set: followsSet },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: skillsSetKey(fieldSetId) });
      onClose();
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (team) create.mutate();
  }

  return (
    <Modal labelledBy={headingId} onCancel={onClose}>
      <form onSubmit={handleSubmit}>
        <h2 id={headingId}>{t("skillsControl.startHeading", { name: field.name })}</h2>
        <div className="field">
          <label className="field__label" htmlFor={typeSelectId}>
            {t("skillsControl.typeLabel")}
          </label>
          <select
            id={typeSelectId}
            className="select"
            value={skillsType}
            onChange={(event) => {
              setSkillsType(event.target.value);
              setTeam("");
            }}
          >
            {types.map((type) => (
              <option key={type.key} value={type.key}>
                {type.label}
              </option>
            ))}
          </select>
          {!followsSet && <p className="field__hint">{t("skillsControl.ownTimerHint")}</p>}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={teamSelectId}>
            {t("skillsControl.teamLabel")}
          </label>
          <select
            id={teamSelectId}
            className="select"
            value={team}
            data-autofocus
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">{t("skillsControl.teamPlaceholder")}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>{`${option.number} ${option.name}`}</option>
            ))}
          </select>
          {loaded && options.length === 0 && <p className="field__hint">{t("skillsControl.noTeams")}</p>}
        </div>
        {create.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(create.error, t("errors.generic"))}
          </p>
        )}
        <div className="dialog__actions">
          <button type="submit" className="btn btn-primary" disabled={!team || create.isPending}>
            {t("skillsControl.startConfirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("skillsControl.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
