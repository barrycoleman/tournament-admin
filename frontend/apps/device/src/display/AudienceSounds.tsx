import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  latestStartedMatchForFieldSet,
  matchCues,
  type MatchReading,
  remainingSeconds,
  timeoutCues,
  useServerNow,
} from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches } from "./api";
import { SoundPlayer, SoundPlayerContext } from "./soundPlayer";
import { fieldIdsOf } from "./screens/inMatch";

/** Plays the match and time-out tones for an audience group with sounds on,
 * whatever screen it shows, and asks for one click if the browser blocks sound. */
export function AudienceSounds({
  sessionId,
  fieldSetId,
  timeoutDeadline,
}: {
  sessionId: number;
  fieldSetId: number | null;
  timeoutDeadline: string | null;
}) {
  const { t } = useTranslation();
  const provided = useContext(SoundPlayerContext);
  const [player] = useState(() => provided ?? new SoundPlayer());
  useEffect(
    () => () => {
      if (!provided) player.close();
    },
    [player, provided]
  );
  const [blocked, setBlocked] = useState(() => player.blocked);
  const now = useServerNow();
  const matches = useMatches(sessionId);
  const fields = useFields(sessionId);
  const moments = useMatchFormat().data?.moments ?? [];
  const match =
    matches.data && fields.data ? latestStartedMatchForFieldSet(matches.data, fieldIdsOf(fields.data, fieldSetId)) : null;
  const reading: MatchReading | null = match
    ? {
        matchId: match.id,
        phase: match.phase,
        whole: Math.ceil((remainingSeconds(match, now) ?? 0) - 1e-9),
        paused: match.paused,
        endedEarly: match.ended_early,
      }
    : null;
  const timeoutRemaining = timeoutDeadline === null ? null : (Date.parse(timeoutDeadline) - now) / 1000;
  const previous = useRef<{ clock: MatchReading | null; timeout: number | null } | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = { clock: reading, timeout: timeoutRemaining };
    if (before === null) return;
    for (const cue of [...matchCues(before.clock, reading, moments), ...timeoutCues(before.timeout, timeoutRemaining)]) {
      if (cue.sound !== null) player.play(cue.sound);
    }
  });

  if (!blocked) return null;
  return (
    <button
      type="button"
      className="sound-note"
      onClick={() => {
        player
          .unlock()
          .then(() => setBlocked(player.blocked))
          .catch(() => undefined);
      }}
    >
      {t("display.enableSound")}
    </button>
  );
}
