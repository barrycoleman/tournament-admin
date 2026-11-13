import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { useDeviceMutations, useDeviceSettings } from "./useDevices";

/** How long an operator device may sit unused before it is disabled. */
export function IdleTimeoutForm() {
  const { t } = useTranslation();
  const settings = useDeviceSettings();
  const { saveSettings } = useDeviceMutations();
  const [idleDraft, setIdleDraft] = useState("");

  useEffect(() => {
    if (settings.data) setIdleDraft(String(settings.data.idle_minutes));
  }, [settings.data]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveSettings.mutate(Number(idleDraft));
  }

  return (
    <form className="panel" onSubmit={handleSubmit} aria-labelledby="idle-heading">
      <h2 id="idle-heading">{t("devices.idleHeading")}</h2>
      <div className="field">
        <label className="field__label" htmlFor="idle-minutes">
          {t("devices.idleLabel")}
        </label>
        <input
          className="input"
          id="idle-minutes"
          type="number"
          min={15}
          max={1440}
          step={1}
          required
          value={idleDraft}
          aria-describedby="idle-minutes-help"
          onChange={(event) => {
            saveSettings.reset();
            setIdleDraft(event.target.value);
          }}
        />
        <p className="field__hint" id="idle-minutes-help">
          {t("devices.idleHelp")}
        </p>
      </div>
      {saveSettings.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(saveSettings.error, t("errors.generic"))}
        </p>
      )}
      {saveSettings.isSuccess && (
        <p className="alert alert-success" role="status">
          {t("devices.idleSaved")}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={saveSettings.isPending || !settings.data}>
          {t("devices.idleSave")}
        </button>
      </div>
    </form>
  );
}
