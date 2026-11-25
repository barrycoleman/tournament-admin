import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import { AllianceSelectionPanel } from "../finals/AllianceSelectionPanel";
import { FinalsProgress } from "../finals/FinalsProgress";
import { FinalsSetup } from "../finals/FinalsSetup";
import { useFinalsBrackets, useFinalsLiveUpdates, useTeams, type FinalsScope } from "../finals/useFinals";
import { useRankingGroups, type RankingGroup } from "../rankings/useRankingGroups";
import type { FinalsBracket, SessionRead } from "../types";

/**
 * The session's Finals tab. A thin switch: qualification must be finalized,
 * then per division (a switcher when there is more than one) either the
 * set-up page or the state of the finals that already exist.
 */
export function SessionFinalsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  useFinalsLiveUpdates(session.id);
  const finalized = Boolean(session.qualification_finalized_at);

  if (!finalized) {
    return (
      <div className="panel">
        <p>{t("sessions.finals.notFinalized")}</p>
        <Link to={`/sessions/${session.id}/matches`}>{t("sessions.finals.goToMatches")}</Link>
      </div>
    );
  }
  return <FinalsDivisions session={session} />;
}

function FinalsDivisions({ session }: { session: SessionRead }) {
  const { t } = useTranslation();
  const { groups, isLoading, isError } = useRankingGroups({ kind: "session", sessionId: session.id });
  const [selected, setSelected] = useState<string | null>(null);

  if (isError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (isLoading) return <p>{t("sessions.loading")}</p>;
  if (groups.length === 0) {
    return (
      <div className="panel">
        <p>{t("sessions.finals.noRankings")}</p>
      </div>
    );
  }

  const keyOf = (group: RankingGroup) => String(group.divisionId ?? "none");
  const group = groups.find((candidate) => keyOf(candidate) === selected) ?? groups[0];

  return (
    <div>
      {groups.length > 1 && (
        <div className="toolbar toolbar--filters">
          <label className="field">
            <span className="field__label">{t("sessions.finals.divisionLabel")}</span>
            <select className="select" value={keyOf(group)} onChange={(event) => setSelected(event.target.value)}>
              {groups.map((candidate) => (
                <option key={keyOf(candidate)} value={keyOf(candidate)}>
                  {candidate.divisionName ?? t("sessions.finals.noDivision")}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <FinalsForDivision key={keyOf(group)} session={session} group={group} />
    </div>
  );
}

function FinalsForDivision({ session, group }: { session: SessionRead; group: RankingGroup }) {
  const { t } = useTranslation();
  const brackets = useFinalsBrackets({ sessionId: session.id, divisionId: group.divisionId });

  if (brackets.isError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!brackets.data) return <p>{t("sessions.loading")}</p>;
  const current = brackets.data.find((bracket) => bracket.status !== "complete") ?? brackets.data[0];
  if (current) {
    return <ExistingFinals scope={{ sessionId: session.id, divisionId: group.divisionId }} bracket={current} group={group} />;
  }
  return <FinalsSetup session={session} divisionId={group.divisionId} rankings={group.rows} />;
}

/** Finals that already exist: partner picking while alliances form, otherwise their progress. */
function ExistingFinals({ scope, bracket, group }: { scope: FinalsScope; bracket: FinalsBracket; group: RankingGroup }) {
  const { t } = useTranslation();
  const teams = useTeams();
  if (teams.isError) {
    return (
      <div className="panel">
        <p className="alert alert-danger" role="alert">
          {t("errors.generic")}
        </p>
        <button type="button" className="btn" onClick={() => teams.refetch()}>
          {t("sessions.finals.retry")}
        </button>
      </div>
    );
  }
  if (!teams.data) return <p>{t("sessions.loading")}</p>;
  if (bracket.status === "selecting_alliances") {
    return <AllianceSelectionPanel scope={scope} bracket={bracket} rankings={group.rows} teams={teams.data} />;
  }
  return <FinalsProgress scope={scope} bracket={bracket} teams={teams.data} />;
}
