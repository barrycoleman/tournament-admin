import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatClock, skillsClockPhase, skillsClockSeconds } from "@tournament-admin/shared";
import { useFields, useSkillsAttempts, useSkillsSet, useSkillsSettings, useTeamsById, type SkillsAttempt } from "./api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "./components/ScreenFrame";
import { useServerNow } from "./serverClock";
import { useLiveScores } from "./useLiveScores";

function latestFieldAttempt(attempts: SkillsAttempt[], fieldId: number): SkillsAttempt | null {
  let latest: SkillsAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.field_id === fieldId && (latest === null || attempt.id > latest.id)) latest = attempt;
  }
  return latest;
}

/** A skills field's own TV: waiting, the loaded team and full run time, the
 * countdown with the live total, then "Run over" with the breakdown the team
 * checks, and the final score until the next run. */
export function SkillsFieldDisplay({
  sessionId,
  fieldSetId,
  fieldId,
}: {
  sessionId: number;
  fieldSetId: number;
  fieldId: number;
}) {
  const { t } = useTranslation();
  const now = useServerNow();
  const set = useSkillsSet(fieldSetId);
  const fields = useFields(sessionId);
  const settings = useSkillsSettings();
  const attempts = useSkillsAttempts(sessionId);
  const teams = useTeamsById();
  const live = useLiveScores(fieldSetId);
  const fieldName = fields.data?.find((field) => field.id === fieldId)?.name ?? "";
  const run = set.data?.fields.find((field) => field.field_id === fieldId)?.run ?? null;
  const latest = latestFieldAttempt(attempts.data ?? [], fieldId);
  // The newest attempt on this field when the current run first showed (once
  // attempts were loaded), frozen while that run shows: the submit's two
  // refetches (run, attempts) may land in either order. An attempt newer than
  // it, once the run is gone, is that run's submitted score; none (a discard,
  // or a TV switched on between runs) means waiting.
  const baseline = useRef<{ runId: number; latestId: number } | undefined>(undefined);
  const runId = run?.id ?? null;
  const attemptsLoaded = attempts.data !== undefined;
  const latestId = latest?.id ?? 0;
  useEffect(() => {
    if (runId !== null && attemptsLoaded && baseline.current?.runId !== runId) {
      baseline.current = { runId, latestId };
    }
  }, [runId, attemptsLoaded, latestId]);

  if (!set.data || !settings.data) return <WaitingForData title={fieldName} />;
  const types = settings.data.types;
  const typeLabel = (key: string) => types.find((type) => type.key === key)?.label ?? key;

  if (!run) {
    const base = baseline.current?.latestId;
    const submitted = base !== undefined && latest !== null && latest.id > base ? latest : null;
    if (!submitted) return <ScreenNotice title={fieldName} text={t("display.skills.waiting")} />;
    const team = teams?.get(submitted.team_id);
    return (
      <ScreenFrame title={fieldName} subtitle={typeLabel(submitted.skills_type)} className="skills-field">
        <p className="skills-field__team">
          <span className="skills-field__number">{team?.number ?? ""}</span>
          <span className="skills-field__name">{team?.name ?? ""}</span>
        </p>
        <p className="skills-field__label">{t("display.skills.finalScore")}</p>
        <p className="skills-field__total" data-testid="skills-final">
          {submitted.score}
        </p>
      </ScreenFrame>
    );
  }

  const phase = skillsClockPhase(run, now);
  const fullSeconds = run.follows_set
    ? set.data.timer.run_seconds
    : types.find((type) => type.key === run.skills_type)?.run_seconds ?? null;
  const entry = live.skills.find((row) => row.field_id === fieldId);
  return (
    <ScreenFrame title={fieldName} subtitle={typeLabel(run.skills_type)} className="skills-field">
      <p className="skills-field__team">
        <span className="skills-field__number">{run.team_number}</span>
        <span className="skills-field__name">{run.team_name}</span>
      </p>
      {phase === "ended" ? (
        <>
          <p className="in-match__over">{t("display.skills.runOver")}</p>
          <ul className="skills-breakdown" aria-label={t("display.breakdown")}>
            {(entry?.breakdown ?? []).map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <span>{String(item.value)}</span>
              </li>
            ))}
          </ul>
          {typeof entry?.score === "number" && (
            <p className="skills-field__total">
              <span className="skills-field__label">{t("display.col.total")}</span>{" "}
              <span data-testid="skills-total">{entry.score}</span>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="clock" data-testid="skills-clock">
            {formatClock(skillsClockSeconds(run, now, fullSeconds))}
          </p>
          {run.paused && (
            <p className="in-match__paused" role="status">
              {t("display.paused")}
            </p>
          )}
          {phase === "running" && typeof entry?.score === "number" && (
            <p className="live-total live-total--all" data-testid="skills-live">
              <span className="live-total__score">{entry.score}</span>
              <span className="live-total__tag">{t("display.live")}</span>
            </p>
          )}
        </>
      )}
    </ScreenFrame>
  );
}
