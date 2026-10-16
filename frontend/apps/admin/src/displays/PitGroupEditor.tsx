import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PIT_SCREENS,
  ROTATION_SECONDS,
  SCROLLING_SCREENS,
  defaultSettings,
  isScreenKey,
  type RotationEntry,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ScreenSettingsEditor } from "./ScreenSettingsEditor";
import type { DisplayGroupRead } from "./types";
import { useDisplayMutations } from "./useDisplays";

/** One screen, or an ordered rotation of screens, for a pit group. */
export function PitGroupEditor({ group }: { group: DisplayGroupRead }) {
  const { t } = useTranslation();
  const { updateGroup } = useDisplayMutations(group.session_id);
  const [rotating, setRotating] = useState(group.rotation !== null);
  const [draft, setDraft] = useState<RotationEntry[]>(
    () =>
      group.rotation ?? [
        {
          screen: group.screen ?? "teamwork_rankings",
          settings: group.screen_settings,
          seconds: ROTATION_SECONDS.default,
        },
      ],
  );
  const edit = (index: number, change: Partial<RotationEntry>) =>
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const move = (index: number, by: number) =>
    setDraft((rows) => {
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row);
      return next;
    });

  return (
    <div>
      {updateGroup.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(updateGroup.error, t("errors.generic"))}
        </p>
      )}
      <fieldset className="settings-group">
        <legend className="field__label">{t("displays.pitMode")}</legend>
        <label className="choice">
          <input
            type="radio"
            name={`pit-mode-${group.id}`}
            checked={!rotating}
            onChange={() => {
              setRotating(false);
              updateGroup.mutate({ groupId: group.id, rotation: null });
            }}
          />{" "}
          {t("displays.oneScreen")}
        </label>
        <label className="choice">
          <input type="radio" name={`pit-mode-${group.id}`} checked={rotating} onChange={() => setRotating(true)} /> {t("displays.rotate")}
        </label>
      </fieldset>

      {!rotating && (
        <>
          <div className="field">
            <label className="field__label" htmlFor={`pit-screen-${group.id}`}>
              {t("displays.screen")}
            </label>
            <select
              className="select"
              id={`pit-screen-${group.id}`}
              value={group.screen ?? ""}
              onChange={(event) =>
                updateGroup.mutate({
                  groupId: group.id,
                  screen: event.target.value,
                })
              }
            >
              {PIT_SCREENS.map((key) => (
                <option key={key} value={key}>
                  {t(`displayScreens.${key}`)}
                </option>
              ))}
            </select>
          </div>
          <ScreenSettingsEditor
            screen={group.screen}
            kind="pit"
            settings={group.screen_settings}
            idPrefix={`pit-${group.id}`}
            onChange={(settings) =>
              updateGroup.mutate({
                groupId: group.id,
                screen_settings: settings,
              })
            }
          />
        </>
      )}

      {rotating && (
        <>
          <ol className="list-plain">
            {draft.map((row, index) => {
              const number = index + 1;
              return (
                <li key={index} className="list-row">
                  <select
                    className="select"
                    aria-label={t("displays.screenNumber", { number })}
                    value={row.screen}
                    onChange={(event) => {
                      const screen = event.target.value;
                      edit(index, {
                        screen,
                        settings: isScreenKey(screen) ? defaultSettings(screen, "pit") : {},
                      });
                    }}
                  >
                    {PIT_SCREENS.map((key) => (
                      <option key={key} value={key}>
                        {t(`displayScreens.${key}`)}
                      </option>
                    ))}
                  </select>
                  <ScreenSettingsEditor
                    screen={row.screen}
                    kind="pit"
                    settings={row.settings}
                    idPrefix={`rotation-${group.id}-${index}`}
                    onChange={(settings) => edit(index, { settings })}
                  />
                  {!(isScreenKey(row.screen) && SCROLLING_SCREENS.has(row.screen)) && (
                    <input
                      className="input settings-number"
                      type="number"
                      aria-label={t("displays.secondsFor", { number })}
                      min={ROTATION_SECONDS.min}
                      max={ROTATION_SECONDS.max}
                      value={row.seconds}
                      onChange={(event) => edit(index, { seconds: Number(event.target.value) })}
                    />
                  )}
                  <button className="btn btn-small" type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                    {t("displays.moveUp")}
                  </button>
                  <button className="btn btn-small" type="button" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                    {t("displays.moveDown")}
                  </button>
                  <button
                    className="btn btn-small btn-danger"
                    type="button"
                    disabled={draft.length === 1}
                    onClick={() => setDraft((rows) => rows.filter((_, i) => i !== index))}
                  >
                    {t("displays.removeScreen")}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="form-actions">
            <button
              className="btn"
              type="button"
              onClick={() =>
                setDraft((rows) => [
                  ...rows,
                  {
                    screen: "logo",
                    settings: {},
                    seconds: ROTATION_SECONDS.default,
                  },
                ])
              }
            >
              {t("displays.addScreen")}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => updateGroup.mutate({ groupId: group.id, rotation: draft })}>
              {t("displays.saveRotation")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
