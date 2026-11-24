import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SOUND_SLOTS, type SoundSlot } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import {
  MAX_SOUND_BYTES,
  MAX_SOUND_SECONDS,
  playSound,
  soundSeconds,
  useEventSounds,
  useSoundMutations,
  type EventSoundRow,
} from "./useEventSounds";

const ACCEPT = "audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav";

function SoundRow({ slot, row }: { slot: SoundSlot; row: EventSoundRow | undefined }) {
  const { t } = useTranslation();
  const { upload, restore } = useSoundMutations();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const name = t(`sounds.slots.${slot}.name`);

  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    if (file.size > MAX_SOUND_BYTES) {
      setProblem(t("sounds.tooBig"));
      return;
    }
    try {
      if ((await soundSeconds(file)) > MAX_SOUND_SECONDS) {
        setProblem(t("sounds.tooLong"));
        return;
      }
    } catch {
      setProblem(t("sounds.unreadable"));
      return;
    }
    upload.mutate(
      { slot, file },
      { onError: (error) => setProblem(apiErrorMessage(error, t("errors.generic"))) }
    );
  }

  return (
    <li className="sound-row">
      <div className="toolbar">
        <strong>{name}</strong>
        <span>{t(`sounds.slots.${slot}.when`)}</span>
        <span className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn-small"
          aria-label={t("sounds.playNamed", { name })}
          onClick={() => playSound(slot).catch(() => setProblem(t("sounds.playFailed")))}
        >
          {t("sounds.play")}
        </button>
        <span>{row?.replaced && row.filename ? row.filename : t("sounds.default")}</span>
        <input
          ref={input}
          type="file"
          hidden
          accept={ACCEPT}
          aria-label={t("sounds.uploadNamed", { name })}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void choose(file);
          }}
        />
        <button type="button" className="btn btn-small" disabled={upload.isPending} onClick={() => input.current?.click()}>
          {t("sounds.upload")}
        </button>
        {row?.replaced && (
          <button type="button" className="btn btn-small" disabled={restore.isPending} onClick={() => restore.mutate(slot)}>
            {t("sounds.restore")}
          </button>
        )}
      </div>
      {(problem || restore.isError) && (
        <p className="alert alert-danger" role="alert">
          {problem ?? apiErrorMessage(restore.error, t("errors.generic"))}
        </p>
      )}
    </li>
  );
}

/** The five cue sounds: what each is for, play it, replace it, restore the default. */
export function SoundsSection() {
  const { t } = useTranslation();
  const sounds = useEventSounds();
  return (
    <section className="panel" aria-labelledby="sounds-heading">
      <h2 id="sounds-heading">{t("sounds.heading")}</h2>
      {sounds.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(sounds.error, t("errors.generic"))}
        </p>
      )}
      <ul className="list-plain">
        {SOUND_SLOTS.map((slot) => (
          <SoundRow key={slot} slot={slot} row={sounds.data?.find((r) => r.slot === slot)} />
        ))}
      </ul>
      <p className="field__hint">{t("sounds.rights")}</p>
    </section>
  );
}
