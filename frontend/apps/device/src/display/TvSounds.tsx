import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SoundPlayer, type Cue, type SoundSlot } from "@tournament-admin/shared";
import { paths, useEventSounds, useFetchAudio } from "./api";
import { useFollowedCues, type Follows } from "./useCueStream";

/** Plays the cues of the timer a TV follows, for a TV whose sound is on,
 * whatever screen it shows, and asks for one click if the browser blocks sound. */
export function TvSounds({ sessionId, follows }: { sessionId: number; follows: Follows }) {
  const { t } = useTranslation();
  const fetchAudio = useFetchAudio();
  const [player] = useState(
    () => new SoundPlayer((slot, useDefault) => fetchAudio(paths.soundAudio(slot, useDefault)))
  );
  const [blocked, setBlocked] = useState(() => player.blocked);
  useEffect(() => {
    void player.preload();
    return () => player.close();
  }, [player]);

  // An organiser's upload or restore changes a slot's row: drop that sound
  // and fetch it again.
  const sounds = useEventSounds().data;
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
  useFollowedCues(sessionId, follows, onCues);

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
