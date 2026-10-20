import { useTranslation } from "react-i18next";
import { formatClock, skillsClockPhase, skillsClockSeconds } from "@tournament-admin/shared";
import { useFieldSets, useSkillsSet, useSkillsSettings } from "./api";
import { ScreenFrame, WaitingForData } from "./components/ScreenFrame";
import { useServerNow } from "./serverClock";

/** A skills field set's audience TV: the set's name, its type and its shared
 * countdown, never a score. */
export function SkillsSetDisplay({ sessionId, fieldSetId }: { sessionId: number; fieldSetId: number }) {
  const { t } = useTranslation();
  const now = useServerNow();
  const set = useSkillsSet(fieldSetId);
  const fieldSets = useFieldSets(sessionId);
  const settings = useSkillsSettings();
  const name = fieldSets.data?.find((fieldSet) => fieldSet.id === fieldSetId)?.name ?? "";
  if (!set.data || !settings.data) return <WaitingForData title={name} />;
  const timer = set.data.timer;
  const typeLabel =
    timer.skills_type === null
      ? undefined
      : settings.data.types.find((type) => type.key === timer.skills_type)?.label ?? timer.skills_type;
  const phase = skillsClockPhase(timer, now);
  return (
    <ScreenFrame title={name} subtitle={typeLabel} className="skills-set-tv">
      <div className="in-match__centre">
        <p className="clock" data-testid="set-clock">
          {formatClock(skillsClockSeconds(timer, now, timer.run_seconds))}
        </p>
        {phase === "ended" && <p className="in-match__over">{t("display.skills.timeUp")}</p>}
      </div>
      {phase === "running" && timer.paused && (
        <p className="in-match__paused" role="status">
          {t("display.paused")}
        </p>
      )}
    </ScreenFrame>
  );
}
