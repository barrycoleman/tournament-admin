import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { latestStartedMatchForFieldSet, remainingSeconds } from "@tournament-admin/shared";
import { useFields, useMatches } from "./api";
import { matchCues, timeoutCues, type ClockState } from "./logic/sounds";
import { useServerNow } from "./serverClock";
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
  const [blocked, setBlocked] = useState(() => player.blocked);
  const now = useServerNow();
  const matches = useMatches(sessionId);
  const fields = useFields(sessionId);
  const match =
    matches.data && fields.data ? latestStartedMatchForFieldSet(matches.data, fieldIdsOf(fields.data, fieldSetId)) : null;
  const reading: ClockState | null = match
    ? { matchId: match.id, phase: match.phase, whole: Math.ceil((remainingSeconds(match, now) ?? 0) - 1e-9), paused: match.paused }
    : null;
  const timeoutRemaining = timeoutDeadline === null ? null : (Date.parse(timeoutDeadline) - now) / 1000;
  const previous = useRef<{ clock: ClockState | null; timeout: number | null } | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = { clock: reading, timeout: timeoutRemaining };
    if (before === null) return;
    for (const cue of [...matchCues(before.clock, reading), ...timeoutCues(before.timeout, timeoutRemaining)]) {
      player.play(cue);
    }
  });

  if (!blocked) return null;
  return (
    <button
      type="button"
      className="sound-note"
      onClick={() => {
        void player.unlock().then(() => setBlocked(player.blocked));
      }}
    >
      {t("display.enableSound")}
    </button>
  );
}
