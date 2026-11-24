import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  SoundPlayer,
  apiRequest,
  useMatchReadingFrom,
  useRealtimeChannel,
  useServerNow,
  useSkillsReading,
  useTimerCues,
  type Cue,
  type LiveMatch,
  type Moment,
  type SkillsClockState,
  type SoundSlot,
} from "@tournament-admin/shared";
import { SOUNDS_KEY, fetchSoundBytes, type EventSoundRow } from "../devices/useEventSounds";
import { useOperatorSoundSetting, type OperatorSoundPage } from "./useOperatorSoundSetting";

/** One timer an operator page follows for its cues. */
export type OperatorStream =
  | { kind: "match"; key: string; matches: LiveMatch[]; fieldIds: readonly number[]; timeoutDeadline: string | null }
  | { kind: "skills"; key: string; timer: SkillsClockState | null };

function Stream({
  stream,
  moments,
  onCues,
}: {
  stream: OperatorStream;
  moments: Moment[] | undefined;
  onCues: (cues: Cue[]) => void;
}) {
  const now = useServerNow(100);
  const matchesOn = stream.kind === "match" ? stream.matches : undefined;
  const fieldIds = stream.kind === "match" ? stream.fieldIds : [];
  const match = useMatchReadingFrom(matchesOn, fieldIds);
  const skills = useSkillsReading(stream.kind === "skills" ? stream.timer : null, stream.key);
  const deadline = stream.kind === "match" ? stream.timeoutDeadline : null;
  const timeout = deadline === null ? null : (Date.parse(deadline) - now) / 1000;
  // Match Control renders only once its matches and fields have loaded.
  useTimerCues({ key: stream.key, match, matchLoaded: stream.kind === "match", skills, timeout, moments }, onCues);
  return null;
}

/** The per-browser "Play sounds on this computer" switch for an operator
 * page, and, when it is on, the cue sounds for the timers the page shows.
 * No flashes. */
export function OperatorSounds({ page, streams }: { page: OperatorSoundPage; streams: OperatorStream[] }) {
  const { t } = useTranslation();
  const [on, setOn] = useOperatorSoundSetting(page);
  return (
    <>
      <label className="choice">
        <input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} /> {t("operatorSounds.switch")}
      </label>
      {on && <ActiveSounds streams={streams} />}
    </>
  );
}

function ActiveSounds({ streams }: { streams: OperatorStream[] }) {
  const { t } = useTranslation();
  const [player] = useState(() => new SoundPlayer(fetchSoundBytes));
  const [blocked, setBlocked] = useState(() => player.blocked);
  useEffect(() => {
    void player.preload();
    return () => player.close();
  }, [player]);

  const moments = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<{ moments: Moment[] }>("/api/event/match-format"),
  }).data?.moments;

  // An upload or restore (on any admin's computer) changes a slot's row: read
  // the rows again, then drop that sound and fetch it again.
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (message) => {
      if (message.event === "sounds_changed") void queryClient.invalidateQueries({ queryKey: SOUNDS_KEY });
    },
  });
  const sounds = useQuery({ queryKey: SOUNDS_KEY, queryFn: () => apiRequest<EventSoundRow[]>("/api/sounds") }).data;
  const seen = useRef<Map<SoundSlot, string> | null>(null);
  useEffect(() => {
    if (!sounds) return;
    const now = new Map(sounds.map((row) => [row.slot, `${row.replaced}|${row.filename}|${row.uploaded_at}`]));
    const before = seen.current;
    seen.current = now;
    if (before === null) return;
    let changed = false;
    for (const [slot, version] of now) {
      if (before.get(slot) !== version) {
        player.reload(slot);
        changed = true;
      }
    }
    if (changed) void player.preload();
  }, [sounds, player]);

  const onCues = useCallback(
    (cues: Cue[]) => {
      for (const cue of cues) if (cue.sound !== null) player.play(cue.sound);
    },
    [player]
  );

  return (
    <>
      {streams.map((stream) => (
        <Stream key={stream.key} stream={stream} moments={moments} onCues={onCues} />
      ))}
      {blocked && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            player
              .unlock()
              .then(() => setBlocked(player.blocked))
              .catch(() => undefined);
          }}
        >
          {t("operatorSounds.enable")}
        </button>
      )}
    </>
  );
}
