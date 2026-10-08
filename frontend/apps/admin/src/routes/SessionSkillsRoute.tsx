import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { AttemptsTable } from "../skills/AttemptsTable";
import { RecordAttemptForm } from "../skills/RecordAttemptForm";
import { SessionAttemptsSettings } from "../skills/SessionAttemptsSettings";
import { useSkillsLiveUpdates } from "../skills/liveUpdates";
import { useSessionSkills, useSkillsAttempts } from "../skills/useSessionSkills";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { ParticipationRead, SessionRead, TeamSummary } from "../types";

export function SessionSkillsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  useSkillsLiveUpdates();
  const settings = useSkillsSettings();
  const sessionSkills = useSessionSkills(session.id);
  const attempts = useSkillsAttempts(session.id);
  const teams = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  // Same key the Check-In tab writes, so a check-in made there shows here at once.
  const participants = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () => apiRequest<ParticipationRead[]>(`/api/sessions/${session.id}/participants`),
  });

  if (settings.isLoading) return <p>{t("skills.page.loading")}</p>;
  if (settings.isError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!settings.data?.enabled) {
    return (
      <p className="alert alert-warning">
        {t("skills.page.off")} <Link to="/events/setup">{t("skills.page.offLink")}</Link>
      </p>
    );
  }
  const queries = [sessionSkills, attempts, teams, participants];
  if (queries.some((query) => query.isError)) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!sessionSkills.data || !attempts.data || !teams.data || !participants.data) {
    return <p>{t("skills.page.loading")}</p>;
  }
  const checkedInIds = new Set(participants.data.filter((row) => row.checked_in).map((row) => row.team_id));
  const checkedIn = teams.data.filter((team) => checkedInIds.has(team.id));

  return (
    <div className="skills-page">
      <SessionAttemptsSettings sessionId={session.id} skills={sessionSkills.data} />
      <RecordAttemptForm
        sessionId={session.id}
        types={sessionSkills.data.types}
        teams={checkedIn}
        attempts={attempts.data}
      />
      <AttemptsTable
        sessionId={session.id}
        types={sessionSkills.data.types}
        attempts={attempts.data}
        teams={teams.data}
      />
    </div>
  );
}
