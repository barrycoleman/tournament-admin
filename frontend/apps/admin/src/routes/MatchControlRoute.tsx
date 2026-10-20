import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AUDIENCE_SCREENS,
  TIMEOUT_SECONDS,
  apiRequest,
  formatClock,
  lastScoredMatch,
  latestStartedMatchForFieldSet,
  nextMatchForFieldSet,
  onFields,
  remainingSeconds,
  sortMatches,
  type AllianceScore,
  type LiveMatch,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { ScreenSettingsEditor } from "../displays/ScreenSettingsEditor";
import type { DisplayGroupRead, FieldRead, FieldSetLiveRead } from "../displays/types";
import { useMatchControlActions, useMatchControlData, type LiveScoresSwitch } from "../matchControl/useMatchControl";
import type { EventRead, SessionRead, TeamSummary } from "../types";

const STORAGE_KEY = "tournament-admin.matchControl.fieldSet";
/** Phases a "reset this period" applies to (the server refuses it elsewhere). */
const SECTION_PHASES = new Set(["countdown_autonomous", "autonomous", "countdown_driver", "driver"]);

function readStoredFieldSet(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function storeFieldSet(id: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // Remembering the tab is a convenience only.
  }
}

function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function teamNumbers(match: LiveMatch, teams: Map<number, TeamSummary>, versus: string): string {
  return match.alliances
    .map((alliance) => alliance.team_ids.map((id) => teams.get(id)?.number ?? "?").join(" "))
    .join(` ${versus} `);
}

export function MatchControlRoute() {
  const { t } = useTranslation();
  const event = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const sessionId = event.data?.active_session_id ?? null;
  return (
    <div>
      <h1>{t("matchControl.heading")}</h1>
      {event.data && sessionId === null && (
        <p className="alert alert-warning">
          {t("matchControl.noSession")} <Link to="/sessions">{t("matchControl.sessionsLink")}</Link>
        </p>
      )}
      {sessionId !== null && <MatchControlBody sessionId={sessionId} />}
    </div>
  );
}

function MatchControlBody({ sessionId }: { sessionId: number }) {
  const { t } = useTranslation();
  const data = useMatchControlData(sessionId);
  const [selected, setSelected] = useState<number | null>(readStoredFieldSet);
  // Matches run on teamwork sets only; skills sets belong to Skills Control.
  const fieldSets = (data.fieldSets.data ?? []).filter((fs) => fs.purpose !== "skills");
  if (data.fieldSets.data && fieldSets.length === 0) return <p>{t("matchControl.noFields")}</p>;
  const fieldSet = fieldSets.find((fs) => fs.id === selected) ?? fieldSets[0];
  if (!fieldSet || !data.fields.data || !data.matches.data || !data.teams.data || !data.scores.data || !data.displays.data) {
    return <p>{t("matchControl.loading")}</p>;
  }
  const audience = data.displays.data.groups.find((g) => g.kind === "audience" && g.field_set_id === fieldSet.id) ?? null;
  return (
    <>
      <div className="division-tabs" role="tablist" aria-label={t("matchControl.fieldGroups")}>
        {fieldSets.map((fs) => (
          <button
            key={fs.id}
            type="button"
            role="tab"
            className="division-tabs__tab"
            aria-selected={fs.id === fieldSet.id}
            onClick={() => {
              setSelected(fs.id);
              storeFieldSet(fs.id);
            }}
          >
            {fs.name}
          </button>
        ))}
      </div>
      <FieldSetPanel
        key={fieldSet.id}
        fieldSet={fieldSet}
        fields={data.fields.data}
        matches={data.matches.data}
        scores={data.scores.data}
        teams={new Map(data.teams.data.map((team) => [team.id, team]))}
        audience={audience}
        session={data.sessions.data?.find((s) => s.id === sessionId) ?? null}
      />
    </>
  );
}

function FieldSetPanel({
  fieldSet,
  fields,
  matches,
  scores,
  teams,
  audience,
  session,
}: {
  fieldSet: FieldSetLiveRead;
  fields: FieldRead[];
  matches: LiveMatch[];
  scores: AllianceScore[];
  teams: Map<number, TeamSummary>;
  audience: DisplayGroupRead | null;
  session: SessionRead | null;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const actions = useMatchControlActions();
  const [changing, setChanging] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(TIMEOUT_SECONDS.default));

  const fieldIds = fields.filter((f) => f.field_set_id === fieldSet.id).map((f) => f.id);
  const fieldName = (id: number | null) => fields.find((f) => f.id === id)?.name ?? "";
  const next = nextMatchForFieldSet(matches, fieldIds, fieldSet.queued_match_id);
  const current = latestStartedMatchForFieldSet(matches, fieldIds);
  const running = current !== null && current.phase !== "ended" ? current : null;
  const saved = lastScoredMatch(matches, scores, fieldIds);
  const unstarted = sortMatches(
    matches.filter((m) => onFields(fieldIds)(m) && m.phase === "not_started" && m.status !== "completed" && m.status !== "not_played")
  );
  const timeoutLeft = fieldSet.timeout_deadline ? (Date.parse(fieldSet.timeout_deadline) - now) / 1000 : 0;
  const failed = Object.values(actions).find((mutation) => mutation.isError);
  const liveSwitch: LiveScoresSwitch = current?.is_finals ? "live_scores_finals" : "live_scores_qualification";
  // An older server leaves the switches out; fall back to its defaults (qualification on, finals off).
  const liveOn = session ? (session[liveSwitch] ?? liveSwitch === "live_scores_qualification") : null;
  const act = (matchId: number, action: Parameters<typeof actions.matchAction.mutate>[0]["action"], body?: unknown) =>
    actions.matchAction.mutate({ matchId, action, body });

  return (
    <div className="match-control">
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}

      <section className="panel" role="region" aria-label={t("matchControl.nextHeading")}>
        <h2>{t("matchControl.nextHeading")}</h2>
        {next ? (
          <>
            <p className="match-control__match">{`${next.label} · ${fieldName(next.field_id)}`}</p>
            <p className="match-control__teams">{teamNumbers(next, teams, t("matchControl.versus"))}</p>
          </>
        ) : (
          <p>{t("matchControl.noNext")}</p>
        )}
        <div className="form-actions">
          <button
            className="btn btn-primary btn-large"
            type="button"
            disabled={next === null || running !== null || actions.matchAction.isPending}
            onClick={() => next && act(next.id, "start")}
          >
            {t("matchControl.start")}
          </button>
          <button className="btn" type="button" onClick={() => setChanging((v) => !v)} disabled={unstarted.length === 0}>
            {t("matchControl.change")}
          </button>
          {fieldSet.queued_match_id !== null && (
            <button className="btn" type="button" onClick={() => actions.queue.mutate({ fieldSetId: fieldSet.id, matchId: null })}>
              {t("matchControl.clearQueue")}
            </button>
          )}
        </div>
        {changing && (
          <div className="field">
            <label className="field__label" htmlFor="queue-match">
              {t("matchControl.queueLabel")}
            </label>
            <select
              className="select"
              id="queue-match"
              value=""
              onChange={(event) => {
                actions.queue.mutate({ fieldSetId: fieldSet.id, matchId: Number(event.target.value) });
                setChanging(false);
              }}
            >
              <option value="" disabled>
                {t("matchControl.queuePlaceholder")}
              </option>
              {unstarted.map((m) => (
                <option key={m.id} value={m.id}>{`${m.label} · ${fieldName(m.field_id)}`}</option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="panel" role="region" aria-label={t("matchControl.timerHeading")}>
        <h2>{t("matchControl.timerHeading")}</h2>
        {current === null ? (
          <p>{t("matchControl.noRunning")}</p>
        ) : (
          <>
            <p className="match-control__match">{`${current.label} · ${fieldName(current.field_id)}`}</p>
            <p className="match-control__clock" data-testid="mc-clock">
              {current.phase === "ended" ? "0:00" : formatClock(remainingSeconds(current, now) ?? 0)}
            </p>
            <p>
              {current.paused ? t("matchControl.paused") : t(`matchControl.phase.${current.phase}`, { defaultValue: current.phase })}
            </p>
            <div className="form-actions">
              {current.status !== "completed" && (
                <Link className="btn" to={`/sessions/${current.session_id}/matches/${current.id}/score`}>
                  {t("matchControl.score")}
                </Link>
              )}
              {session && liveOn !== null && (
                <button
                  className="btn"
                  type="button"
                  disabled={actions.setLiveScores.isPending}
                  onClick={() => actions.setLiveScores.mutate({ sessionId: session.id, field: liveSwitch, value: !liveOn })}
                >
                  {liveOn ? t("matchControl.hideLive") : t("matchControl.showLive")}
                </button>
              )}
            </div>
            {current.phase === "ended" ? (
              <p>{current.status === "completed" ? t("matchControl.scoreSaved") : t("matchControl.waitingForScore")}</p>
            ) : (
              <div className="form-actions">
                {current.phase === "awaiting_driver" && (
                  <button className="btn btn-primary" type="button" onClick={() => act(current.id, "start-driver")}>
                    {t("matchControl.startDriver")}
                  </button>
                )}
                {SECTION_PHASES.has(current.phase) &&
                  (current.paused ? (
                    <button className="btn btn-primary" type="button" onClick={() => act(current.id, "resume")}>
                      {t("matchControl.resume")}
                    </button>
                  ) : (
                    <button className="btn" type="button" onClick={() => act(current.id, "pause")}>
                      {t("matchControl.pause")}
                    </button>
                  ))}
                <button className="btn btn-danger" type="button" onClick={() => setConfirmEnd(true)}>
                  {t("matchControl.endEarly")}
                </button>
                <button className="btn" type="button" onClick={() => setResetting(true)}>
                  {t("matchControl.reset")}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel" role="region" aria-label={t("matchControl.savedHeading")}>
        <h2>{t("matchControl.savedHeading")}</h2>
        {saved === null ? (
          <p>{t("matchControl.noneSaved")}</p>
        ) : (
          <>
            <p className="match-control__match">{saved.label}</p>
            <ul className="list-plain">
              {saved.alliances.map((alliance) => (
                <li key={alliance.id}>
                  {`${t(`matchControl.station.${alliance.station}`, { defaultValue: alliance.station })} ${alliance.team_ids
                    .map((id) => teams.get(id)?.number ?? "?")
                    .join(" ")}: `}
                  <strong>{scores.find((s) => s.alliance_id === alliance.id)?.score ?? "–"}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {audience && (
        <section className="panel" role="region" aria-label={t("matchControl.audienceHeading")}>
          <h2>{t("matchControl.audienceHeading")}</h2>
          <div className="toolbar">
            {AUDIENCE_SCREENS.map((key) => (
              <button
                key={key}
                type="button"
                className={`btn btn-small${audience.screen === key ? " btn-primary" : ""}`}
                aria-pressed={audience.screen === key}
                onClick={() => actions.updateGroup.mutate({ groupId: audience.id, screen: key })}
              >
                {t(`displayScreens.${key}`)}
              </button>
            ))}
          </div>
          <ScreenSettingsEditor
            screen={audience.screen}
            kind="audience"
            settings={audience.screen_settings}
            idPrefix={`audience-${audience.id}`}
            onChange={(settings) => actions.updateGroup.mutate({ groupId: audience.id, screen_settings: settings })}
          />
          <label className="choice">
            <input
              type="checkbox"
              checked={audience.play_sounds}
              onChange={(event) => actions.updateGroup.mutate({ groupId: audience.id, play_sounds: event.target.checked })}
            />{" "}
            {t("matchControl.playSounds")}
          </label>
        </section>
      )}

      <section className="panel" role="region" aria-label={t("matchControl.timeoutHeading")}>
        <h2>{t("matchControl.timeoutHeading")}</h2>
        {timeoutLeft > 0 ? (
          <div className="form-actions">
            <p className="match-control__clock">{formatClock(timeoutLeft)}</p>
            <button className="btn" type="button" onClick={() => actions.cancelTimeout.mutate(fieldSet.id)}>
              {t("matchControl.cancelTimeout")}
            </button>
          </div>
        ) : (
          <div className="toolbar">
            <div className="field">
              <label className="field__label" htmlFor="timeout-seconds">
                {t("matchControl.timeoutLength")}
              </label>
              <input
                className="input settings-number"
                id="timeout-seconds"
                type="number"
                min={TIMEOUT_SECONDS.min}
                max={TIMEOUT_SECONDS.max}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
              />
            </div>
            <button
              className="btn"
              type="button"
              disabled={
                !Number.isInteger(Number(timeoutSeconds)) ||
                Number(timeoutSeconds) < TIMEOUT_SECONDS.min ||
                Number(timeoutSeconds) > TIMEOUT_SECONDS.max
              }
              onClick={() => actions.startTimeout.mutate({ fieldSetId: fieldSet.id, seconds: Number(timeoutSeconds) })}
            >
              {t("matchControl.startTimeout")}
            </button>
          </div>
        )}
      </section>

      {confirmEnd && current && (
        <ConfirmDialog
          heading={t("matchControl.endHeading")}
          body={t("matchControl.endBody")}
          confirmLabel={t("matchControl.endEarly")}
          cancelLabel={t("matchControl.cancel")}
          onConfirm={() => {
            act(current.id, "end");
            setConfirmEnd(false);
          }}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {resetting && current && (
        <Modal labelledBy="reset-heading" onCancel={() => setResetting(false)}>
          <h2 id="reset-heading">{t("matchControl.resetHeading")}</h2>
          <div className="dialog__actions">
            {SECTION_PHASES.has(current.phase) && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  act(current.id, "reset", { scope: "section" });
                  setResetting(false);
                }}
              >
                {t("matchControl.resetSection")}
              </button>
            )}
            <button
              className="btn btn-danger"
              type="button"
              onClick={() => {
                act(current.id, "reset", { scope: "full" });
                setResetting(false);
              }}
            >
              {t("matchControl.resetFull")}
            </button>
            <button className="btn" type="button" onClick={() => setResetting(false)}>
              {t("matchControl.cancel")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
