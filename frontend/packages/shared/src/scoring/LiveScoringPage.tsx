import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api-client";
import type { LiveMatch } from "../display/types";
import {
  ScoresheetForm,
  defaultValues,
  type ScoresheetField,
  type ScoresheetTranslate,
  type ScoresheetValues,
} from "../scoresheet";
import { errorText, scoringPaths } from "./api";
import { ClockControls } from "./ClockControls";
import { teamFlagKey } from "./mergeDraft";
import { flashKey, useLiveDraft } from "./useLiveDraft";
import type {
  AllianceDraft,
  MatchClockAction,
  ScoringMatchFormat,
  ScoringRequest,
  ScoringSocket,
  SubmitViolation,
  TeamFlag,
} from "./types";

export interface ScoringTeam {
  id: number;
  number: string;
  name: string;
}

export interface ScoringAlliance {
  alliance_id: number;
  station: string;
  teams: ScoringTeam[];
}

export interface LiveScoringPageProps {
  matchId: number;
  sessionId: number;
  t: ScoresheetTranslate;
  myDeviceName: string;
  /** The match as GET /api/matches/{id} returns it; the caller keeps it current from match events. */
  match: LiveMatch;
  alliances: ScoringAlliance[];
  schema: ScoresheetField[];
  matchFormat: ScoringMatchFormat;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** Called after a clock action succeeds, so the caller can refetch the match. */
  onClockChanged?: () => void;
}

const NARROW_QUERY = "(max-width: 719px)";

/** True under 720 px wide, where alliances become tabs. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

interface Sheet {
  allianceId: number;
  title: string;
  teams: (ScoringTeam & { allianceId: number })[];
}

/**
 * Live scoring for one teamwork match: one column per alliance (tabs on a
 * narrow screen), each change saved at once as a draft, clock controls, and
 * Submit. Cooperative games score one shared sheet. Key it by match id.
 */
export function LiveScoringPage({
  matchId,
  sessionId,
  t,
  myDeviceName,
  match,
  alliances,
  schema,
  matchFormat,
  socketEvents,
  request,
  onClockChanged,
}: LiveScoringPageProps) {
  const cooperative = matchFormat.game_model === "cooperative_score";
  const defaults = useMemo(() => defaultValues(schema), [schema]);
  const live = useLiveDraft({ matchId, sessionId, myDeviceName, socketEvents, request, defaults, cooperative });
  const narrow = useNarrow();
  const [tab, setTab] = useState(0);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  const stationLabel = (station: string) => t(`scoring.station.${station}`, { defaultValue: station });
  const ordered = [...alliances].sort((a, b) => a.alliance_id - b.alliance_id);
  const sheets: Sheet[] = cooperative
    ? [
        {
          allianceId: ordered[0]?.alliance_id ?? 0,
          title: t("scoring.sharedSheet"),
          teams: ordered.flatMap((alliance) => alliance.teams.map((team) => ({ ...team, allianceId: alliance.alliance_id }))),
        },
      ]
    : alliances.map((alliance) => ({
        allianceId: alliance.alliance_id,
        title: stationLabel(alliance.station),
        teams: alliance.teams.map((team) => ({ ...team, allianceId: alliance.alliance_id })),
      }));

  const runClock = async (action: MatchClockAction, body?: { scope: "section" | "full" }) => {
    setClockBusy(true);
    setClockError(null);
    try {
      await (request ?? apiRequest)(scoringPaths.matchAction(matchId, action), body ? { method: "POST", body } : { method: "POST" });
      onClockChanged?.();
    } catch (error) {
      setClockError(errorText(error) ?? t("scoring.error"));
    } finally {
      setClockBusy(false);
    }
  };

  if (live.gone || match.status === "not_played") {
    return (
      <p className="alert alert-warning" role="status">
        {t("scoring.gone")}
      </p>
    );
  }

  if (live.submitted) {
    return (
      <section className="panel scoring__saved" role="region" aria-label={t("scoring.savedHeading")}>
        <h2>{t("scoring.savedHeading")}</h2>
        <ul className="list-plain">
          {alliances.map((alliance) => (
            <li key={alliance.alliance_id}>
              {`${stationLabel(alliance.station)} ${alliance.teams.map((team) => team.number).join(" ")}: `}
              <strong>{live.saved?.find((row) => row.alliance_id === alliance.alliance_id)?.score ?? "–"}</strong>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (live.draft === null) return <p>{t("scoring.loading")}</p>;

  const draftFor = (allianceId: number): AllianceDraft =>
    live.draft?.alliances.find((alliance) => alliance.alliance_id === allianceId) ?? {
      alliance_id: allianceId,
      data: {},
      teams: [],
      item_meta: {},
      version: 0,
      score: 0,
    };
  const flagOf = (teamId: number, flag: TeamFlag): boolean =>
    live.draft?.alliances.some((alliance) => alliance.teams.some((team) => team.team_id === teamId && team[flag])) ?? false;
  const flagFlash = (teamId: number, flag: TeamFlag): string | undefined =>
    Object.entries(live.flashing).find(([key]) => key.endsWith(`:${teamFlagKey(teamId, flag)}`))?.[1];
  const violationLabel = (violation: SubmitViolation) => {
    const alliance = alliances.find((entry) => entry.alliance_id === violation.alliance_id);
    return alliance ? stationLabel(alliance.station) : t("scoring.sharedSheet");
  };
  /** An alliance named the way scorers know it: colour and team numbers. */
  const allianceName = (allianceId: number) => {
    const alliance = alliances.find((entry) => entry.alliance_id === allianceId);
    if (!alliance) return t("scoring.allianceFallback", { id: allianceId });
    return `${stationLabel(alliance.station)} ${alliance.teams.map((team) => team.number).join(" ")}`.trim();
  };
  const visible = narrow && sheets.length > 1 ? [sheets[Math.min(tab, sheets.length - 1)]] : sheets;

  return (
    <div className="scoring">
      <ClockControls match={match} matchFormat={matchFormat} t={t} busy={clockBusy} onAction={(a, b) => void runClock(a, b)} />
      {clockError && (
        <p className="alert alert-danger" role="alert">
          {clockError}
        </p>
      )}
      {live.offline && (
        <p className="alert alert-warning" role="status">
          {live.pending > 0 ? t("scoring.offline") : t("scoring.reconnecting")}
        </p>
      )}
      {live.error !== null && (
        <p className="alert alert-danger" role="alert">
          {live.error || t("scoring.error")}
        </p>
      )}
      {narrow && sheets.length > 1 && (
        <div className="division-tabs" role="tablist" aria-label={t("scoring.alliances")}>
          {sheets.map((sheet, index) => (
            <button
              key={sheet.allianceId}
              type="button"
              role="tab"
              className="division-tabs__tab"
              aria-selected={index === Math.min(tab, sheets.length - 1)}
              onClick={() => setTab(index)}
            >
              {sheet.title}
            </button>
          ))}
        </div>
      )}
      <div className="scoring__columns">
        {visible.map((sheet) => {
          const draft = draftFor(sheet.allianceId);
          const values: ScoresheetValues = { ...defaults, ...draft.data };
          const notes: Record<string, string> = {};
          for (const field of schema) {
            const device = live.flashing[flashKey(sheet.allianceId, field.name)];
            if (device) notes[field.name] = t("scoring.changedBy", { device });
          }
          return (
            <section key={sheet.allianceId} className="panel scoring__column" role="region" aria-label={sheet.title}>
              <h2>{sheet.title}</h2>
              <p className="scoring__total">{t("scoring.scoreSoFar", { score: draft.score })}</p>
              <ul className="list-plain scoring__teams">
                {sheet.teams.map((team) => (
                  <li key={team.id}>
                    <span className="scoring__team">{`${team.number} ${team.name}`}</span>
                    {(["no_show", "dq"] as const).map((flag) => {
                      const device = flagFlash(team.id, flag);
                      return (
                        <span key={flag} className={device ? "scoring__flag scoring__flag--flash" : "scoring__flag"}>
                          <label className="choice">
                            <input
                              type="checkbox"
                              checked={flagOf(team.id, flag)}
                              onChange={(event) => live.setTeamFlag(team.allianceId, team.id, flag, event.target.checked)}
                            />{" "}
                            {t(flag === "no_show" ? "scoring.noShow" : "scoring.dq", { team: team.number })}
                          </label>
                          {device && (
                            <span className="field__hint scoresheet__note" role="status">
                              {t("scoring.changedBy", { device })}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </li>
                ))}
              </ul>
              <ScoresheetForm
                fields={schema}
                values={values}
                notes={notes}
                t={t}
                idPrefix={`alliance-${sheet.allianceId}`}
                onChange={(next) => {
                  for (const field of schema) {
                    if (next[field.name] !== values[field.name]) live.setItem(sheet.allianceId, field.name, next[field.name]);
                  }
                }}
              />
            </section>
          );
        })}
      </div>
      {live.missing.length > 0 && (
        <div className="alert alert-warning" role="alertdialog" aria-label={t("scoring.missingHeading")}>
          <p>
            {t(live.missing.length === 1 ? "scoring.missingOne" : "scoring.missingMany", {
              alliances: live.missing.map(allianceName).join(", "),
            })}
          </p>
          <div className="form-actions">
            <button className="btn btn-primary" type="button" onClick={() => live.confirmZeroAndSubmit()}>
              {t("scoring.saveZero")}
            </button>
            <button className="btn" type="button" onClick={() => live.cancelMissing()}>
              {t("scoring.clock.cancel")}
            </button>
          </div>
        </div>
      )}
      {live.violations && (
        <div className="alert alert-danger" role="alert">
          <p>{t("scoring.violationsHeading")}</p>
          <ul>
            {live.violations.map((violation) => (
              <li key={String(violation.alliance_id)}>{`${violationLabel(violation)}: ${violation.messages.join(" ")}`}</li>
            ))}
          </ul>
          <button className="btn btn-danger" type="button" disabled={live.submitting} onClick={() => live.submit(true)}>
            {t("scoring.submitAnyway")}
          </button>
        </div>
      )}
      <div className="form-actions">
        <button
          className="btn btn-primary btn-large"
          type="button"
          disabled={live.pending > 0 || live.submitting || live.offline}
          onClick={() => live.submit()}
        >
          {live.submitting ? t("scoring.submitting") : t("scoring.submit")}
        </button>
      </div>
    </div>
  );
}
