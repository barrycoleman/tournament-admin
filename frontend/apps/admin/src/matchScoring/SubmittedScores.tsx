import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ScoresheetForm,
  apiRequest,
  defaultValues,
  submitViolations,
  type AllianceScore,
  type LiveMatch,
  type ScoresheetField,
  type ScoresheetValues,
  type ScoringMatchFormat,
  type TeamFlag,
  type TeamFlags,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { useScoresheetT } from "../skills/useScoresheetT";
import type { TeamSummary } from "../types";

interface SubmittedScoresProps {
  match: LiveMatch;
  /** This match's official scores, one per alliance. */
  scores: AllianceScore[];
  schema: ScoresheetField[];
  matchFormat: ScoringMatchFormat;
  teams: Map<number, TeamSummary>;
}

interface CorrectionDraft {
  /** Alliance id -> its sheet (a cooperative game edits the lowest alliance's sheet for all). */
  data: Record<number, ScoresheetValues>;
  /** Team id -> its flags. */
  flags: Record<number, { no_show: boolean; dq: boolean }>;
}

function seed(match: LiveMatch, scores: AllianceScore[], schema: ScoresheetField[]): CorrectionDraft {
  const defaults = defaultValues(schema);
  const data: Record<number, ScoresheetValues> = {};
  const flags: Record<number, { no_show: boolean; dq: boolean }> = {};
  for (const alliance of match.alliances) {
    const score = scores.find((row) => row.alliance_id === alliance.id);
    data[alliance.id] = { ...defaults, ...(score?.data ?? {}) };
    for (const teamId of alliance.team_ids) {
      const flag = score?.teams.find((entry) => entry.team_id === teamId);
      flags[teamId] = { no_show: flag?.no_show ?? false, dq: flag?.dq ?? false };
    }
  }
  return { data, flags };
}

/** A submitted match: its official scores, read-only, with "Correct score" (admin, any session). */
export function SubmittedScores({ match, scores, schema, matchFormat, teams }: SubmittedScoresProps) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CorrectionDraft | null>(null);
  const [corrected, setCorrected] = useState(false);
  const cooperative = matchFormat.game_model === "cooperative_score";
  const alliances = [...match.alliances].sort((a, b) => a.id - b.id);
  const stationLabel = (station: string) => t(`scoring.station.${station}`, { defaultValue: station });
  const teamNumber = (id: number) => teams.get(id)?.number ?? String(id);

  const save = useMutation({
    mutationFn: async ({ draft, force }: { draft: CorrectionDraft; force: boolean }) => {
      // One POST per alliance, in alliance order; a cooperative game sends its one sheet to each.
      for (const alliance of alliances) {
        const data = cooperative ? draft.data[alliances[0].id] : draft.data[alliance.id];
        const flagged: TeamFlags[] = alliance.team_ids
          .map((teamId) => ({ team_id: teamId, ...draft.flags[teamId] }))
          .filter((entry) => entry.no_show || entry.dq);
        await apiRequest(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          method: "POST",
          body: { data, teams: flagged, force },
        });
      }
    },
    onSuccess: async () => {
      setEditing(null);
      setCorrected(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scores", match.session_id] }),
        queryClient.invalidateQueries({ queryKey: ["matches", match.session_id] }),
        queryClient.invalidateQueries({ queryKey: ["match", match.id] }),
      ]);
    },
  });
  const violations = save.error ? submitViolations(save.error) : null;

  if (editing === null) {
    return (
      <div className="match-scoring__submitted">
        {corrected && (
          <p className="alert alert-success" role="status">
            {t("matchScoring.corrected")}
          </p>
        )}
        <div className="scoring__columns">
          {alliances.map((alliance) => {
            const score = scores.find((row) => row.alliance_id === alliance.id);
            return (
              <section key={alliance.id} className="panel" role="region" aria-label={stationLabel(alliance.station)}>
                <h2>{stationLabel(alliance.station)}</h2>
                <p className="scoring__total">{t("matchScoring.officialScore", { score: score?.score ?? "–" })}</p>
                <ul className="list-plain">
                  {alliance.team_ids.map((teamId) => {
                    const flag = score?.teams.find((entry) => entry.team_id === teamId);
                    const notes = [flag?.no_show ? t("matchScoring.noShowTag") : null, flag?.dq ? t("matchScoring.dqTag") : null]
                      .filter(Boolean)
                      .join(", ");
                    return <li key={teamId}>{notes ? `${teamNumber(teamId)} (${notes})` : teamNumber(teamId)}</li>;
                  })}
                </ul>
                <dl className="match-scoring__items">
                  {schema.map((field) => (
                    <div key={field.name}>
                      <dt>{field.label}</dt>
                      <dd>{String(score?.data[field.name] ?? "–")}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
        <div className="form-actions">
          <button
            className="btn"
            type="button"
            onClick={() => {
              save.reset();
              setCorrected(false);
              setEditing(seed(match, scores, schema));
            }}
          >
            {t("matchScoring.correct")}
          </button>
        </div>
      </div>
    );
  }

  const sheets = cooperative ? alliances.slice(0, 1) : alliances;
  const setFlag = (teamId: number, flag: TeamFlag, value: boolean) =>
    setEditing({ ...editing, flags: { ...editing.flags, [teamId]: { ...editing.flags[teamId], [flag]: value } } });

  return (
    <div className="match-scoring__correct">
      <p className="field__hint">{t("matchScoring.correctHint")}</p>
      <div className="scoring__columns">
        {sheets.map((alliance) => {
          const title = cooperative ? t("scoring.sharedSheet") : stationLabel(alliance.station);
          const teamIds = cooperative ? alliances.flatMap((entry) => entry.team_ids) : alliance.team_ids;
          return (
            <section key={alliance.id} className="panel" role="region" aria-label={title}>
              <h2>{title}</h2>
              <ul className="list-plain scoring__teams">
                {teamIds.map((teamId) => (
                  <li key={teamId}>
                    {(["no_show", "dq"] as const).map((flag) => (
                      <label key={flag} className="choice">
                        <input
                          type="checkbox"
                          checked={editing.flags[teamId]?.[flag] ?? false}
                          onChange={(event) => setFlag(teamId, flag, event.target.checked)}
                        />{" "}
                        {t(flag === "no_show" ? "scoring.noShow" : "scoring.dq", { team: teamNumber(teamId) })}
                      </label>
                    ))}
                  </li>
                ))}
              </ul>
              <ScoresheetForm
                fields={schema}
                values={editing.data[alliance.id]}
                t={scoresheetT}
                idPrefix={`correct-${alliance.id}`}
                onChange={(values) => setEditing({ ...editing, data: { ...editing.data, [alliance.id]: values } })}
              />
            </section>
          );
        })}
      </div>
      {violations ? (
        <div className="alert alert-danger" role="alert">
          <p>{t("scoring.violationsHeading")}</p>
          <ul>
            {violations.flatMap((entry) => entry.messages).map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <button
            className="btn btn-danger"
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ draft: editing, force: true })}
          >
            {t("matchScoring.saveAnyway")}
          </button>
        </div>
      ) : (
        save.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(save.error, t("errors.generic"))}
          </p>
        )
      )}
      <div className="form-actions">
        <button
          className="btn btn-primary"
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate({ draft: editing, force: false })}
        >
          {t("matchScoring.saveCorrection")}
        </button>
        <button className="btn" type="button" disabled={save.isPending} onClick={() => setEditing(null)}>
          {t("matchScoring.cancel")}
        </button>
      </div>
    </div>
  );
}
