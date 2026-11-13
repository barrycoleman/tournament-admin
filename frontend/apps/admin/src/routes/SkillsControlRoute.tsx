import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { SkillsSetCard } from "../skillsControl/SkillsSetCard";
import { useNow, useSkillsControlData } from "../skillsControl/useSkillsControl";
import type { EventRead } from "../types";

/** The operator page for skills fields in the active session. */
export function SkillsControlRoute() {
  const { t } = useTranslation();
  const event = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const sessionId = event.data?.active_session_id ?? null;
  return (
    <div>
      <h1>{t("skillsControl.heading")}</h1>
      {event.data && sessionId === null && (
        <p className="alert alert-warning">
          {t("skillsControl.noSession")} <Link to="/sessions">{t("skillsControl.sessionsLink")}</Link>
        </p>
      )}
      {sessionId !== null && <SkillsControlBody sessionId={sessionId} />}
    </div>
  );
}

function SkillsControlBody({ sessionId }: { sessionId: number }) {
  const { t } = useTranslation();
  const now = useNow();
  const data = useSkillsControlData(sessionId);
  const settings = data.settings.data;
  if (settings && !settings.enabled) {
    return (
      <p className="alert alert-warning">
        {t("skillsControl.skillsOff")} <Link to="/events/setup">{t("skillsControl.skillsOffLink")}</Link>
      </p>
    );
  }
  if (data.fieldSets.data && data.skillsSets.length === 0) {
    return (
      <p>
        {t("skillsControl.noSets")} <Link to={`/sessions/${sessionId}/setup#fields`}>{t("skillsControl.fieldsLink")}</Link>
      </p>
    );
  }
  const sessionSkills = data.sessionSkills.data;
  const attempts = data.attempts.data;
  const teams = data.teams.data;
  if (!data.fieldSets.data || !settings || !sessionSkills || !attempts || !teams) {
    return <p>{t("skillsControl.loading")}</p>;
  }
  const loaded = data.sets.map((query) => query.data);
  // A team already on any skills field can't start a second run.
  const busyTeamIds = new Set(
    loaded.flatMap((set) => set?.fields.flatMap((field) => (field.run ? [field.run.team_id] : [])) ?? [])
  );
  return (
    <div className="skills-control">
      {data.skillsSets.map((fieldSet, index) => {
        const set = loaded[index];
        if (!set) return <p key={fieldSet.id}>{t("skillsControl.loading")}</p>;
        return (
          <SkillsSetCard
            key={fieldSet.id}
            sessionId={sessionId}
            fieldSet={fieldSet}
            set={set}
            types={settings.types}
            sessionTypes={sessionSkills.types}
            teams={teams}
            attempts={attempts}
            busyTeamIds={busyTeamIds}
            now={now}
            socketEvents={data.socketEvents}
          />
        );
      })}
    </div>
  );
}
