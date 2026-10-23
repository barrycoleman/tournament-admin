import { useTranslation } from "react-i18next";
import { listTimezones } from "../orientation/timezones";

export interface SessionFormValues {
  label: string;
  sessionDate: string;
  timezone: string;
  liveQualification: boolean;
  liveFinals: boolean;
}

/** The label, date, timezone and (when editing) live-score fields shared by every session form. */
export function SessionFormFields({
  values,
  onChange,
  showLiveSwitches = false,
  autoFocus = false,
  timezoneHint,
}: {
  values: SessionFormValues;
  onChange: (values: SessionFormValues) => void;
  /** Only when editing: a new session starts with the server defaults. */
  showLiveSwitches?: boolean;
  autoFocus?: boolean;
  timezoneHint?: string;
}) {
  const { t } = useTranslation();
  const timezones = listTimezones(values.timezone || undefined);

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="session-label">
          {t("sessions.labelLabel")}
        </label>
        <input
          className="input"
          id="session-label"
          value={values.label}
          onChange={(event) => onChange({ ...values, label: event.target.value })}
          autoFocus={autoFocus}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="session-date">
          {t("sessions.dateLabel")}
        </label>
        <input
          className="input"
          id="session-date"
          type="date"
          value={values.sessionDate}
          onChange={(event) => onChange({ ...values, sessionDate: event.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="session-timezone">
          {t("sessions.timezoneLabel")}
        </label>
        <select
          className="select"
          id="session-timezone"
          value={values.timezone}
          onChange={(event) => onChange({ ...values, timezone: event.target.value })}
        >
          <option value="">{t("sessions.noTimezoneOption")}</option>
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        {timezoneHint && <p className="field__hint">{timezoneHint}</p>}
      </div>
      {showLiveSwitches && (
        <fieldset className="field">
          <legend className="field__label">{t("sessions.liveScoresLegend")}</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={values.liveQualification}
              onChange={(event) => onChange({ ...values, liveQualification: event.target.checked })}
            />{" "}
            {t("sessions.liveQualificationLabel")}
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={values.liveFinals}
              onChange={(event) => onChange({ ...values, liveFinals: event.target.checked })}
            />{" "}
            {t("sessions.liveFinalsLabel")}
          </label>
        </fieldset>
      )}
    </>
  );
}
