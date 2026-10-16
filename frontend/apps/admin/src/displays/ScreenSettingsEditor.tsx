import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UPCOMING_COUNT, type GroupKind, type ScreenSettings } from "@tournament-admin/shared";

/** The settings of the screens that have any (today only Upcoming Matches). */
export function ScreenSettingsEditor({
  screen,
  kind,
  settings,
  onChange,
  idPrefix,
}: {
  screen: string | null;
  kind: GroupKind;
  settings: ScreenSettings;
  onChange: (settings: ScreenSettings) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const count = settings.count ?? UPCOMING_COUNT.default;
  const scope = settings.scope ?? (kind === "pit" ? "division" : "field_set");
  const [draft, setDraft] = useState(String(count));
  useEffect(() => setDraft(String(count)), [count]);
  if (screen !== "upcoming_matches") return null;
  return (
    <div className="toolbar">
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-count`}>
          {t("displays.settings.count")}
        </label>
        <input
          className="input settings-number"
          id={`${idPrefix}-count`}
          type="number"
          min={UPCOMING_COUNT.min}
          max={UPCOMING_COUNT.max}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= UPCOMING_COUNT.min && value <= UPCOMING_COUNT.max) {
              onChange({ count: value, scope });
            }
          }}
        />
      </div>
      {kind === "audience" && (
        <div className="field">
          <label className="field__label" htmlFor={`${idPrefix}-scope`}>
            {t("displays.settings.scope")}
          </label>
          <select
            className="select"
            id={`${idPrefix}-scope`}
            value={scope}
            onChange={(event) => onChange({ count, scope: event.target.value as "field_set" | "division" })}
          >
            <option value="field_set">{t("displays.settings.scopeFieldSet")}</option>
            <option value="division">{t("displays.settings.scopeDivision")}</option>
          </select>
        </div>
      )}
    </div>
  );
}
