import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { EditDeviceDialog } from "../devices/EditDeviceDialog";
import { PairDeviceForm } from "../devices/PairDeviceForm";
import { relativeTime } from "../devices/format";
import {
  DEVICES_KEY,
  useDeviceMutations,
  useDeviceSettings,
  useDevices,
  type DeviceRead,
  type DeviceStatus,
} from "../devices/useDevices";

const STATUS_BADGE: Record<DeviceStatus, string> = {
  active: "badge-success",
  idle: "badge-warning",
  disabled: "badge-neutral",
};

export function DevicesRoute() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const devices = useDevices();
  const settings = useDeviceSettings();
  const { setEnabled, remove, saveSettings, clearBinding } = useDeviceMutations();
  const [editing, setEditing] = useState<DeviceRead | null>(null);
  const [deleting, setDeleting] = useState<DeviceRead | null>(null);
  const [idleDraft, setIdleDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      if (event.event === "devices_changed" || event.event === "scorer_binding_changed") {
        void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      }
    },
  });

  useEffect(() => {
    if (settings.data) setIdleDraft(String(settings.data.idle_minutes));
  }, [settings.data]);

  // Keeps "Last seen" moving between refetches.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function handleIdleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveSettings.mutate(Number(idleDraft));
  }

  return (
    <div>
      <h1>{t("devices.heading")}</h1>
      <PairDeviceForm initialCode={params.get("pair") ?? ""} />

      <section className="panel" aria-labelledby="devices-list-heading">
        <h2 id="devices-list-heading">{t("devices.listHeading")}</h2>
        {devices.isError && (
          <p className="alert alert-danger" role="alert">
            {t("devices.loadError")}
          </p>
        )}
        {devices.data && devices.data.length === 0 && <p>{t("devices.empty")}</p>}
        {devices.data && devices.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("devices.columns.name")}</th>
                  <th scope="col">{t("devices.columns.role")}</th>
                  <th scope="col">{t("devices.columns.group")}</th>
                  <th scope="col">{t("devices.columns.status")}</th>
                  <th scope="col">{t("devices.columns.lastSeen")}</th>
                  <th scope="col" className="table__actions">
                    {t("devices.columns.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.data.map((device) => (
                  <tr key={device.id}>
                    <td>{device.name}</td>
                    <td>{t(`devices.roles.${device.role}`, { defaultValue: device.role })}</td>
                    <td>
                      {device.role === "display_device" ? (
                        device.display_group ?? t("devices.noGroup")
                      ) : device.binding ? (
                        <span className="devices__binding">
                          {t("devices.binding", { field: device.binding.field_name })}{" "}
                          <button
                            className="btn btn-small"
                            type="button"
                            disabled={clearBinding.isPending}
                            aria-label={t("devices.clearBindingLabel", { name: device.name })}
                            onClick={() => clearBinding.mutate(device.id)}
                          >
                            {t("devices.clearBinding")}
                          </button>
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[device.status] ?? "badge-neutral"}`}>
                        {t(`devices.status.${device.status}`, { defaultValue: device.status })}
                      </span>
                    </td>
                    <td className="table__nowrap">
                      {relativeTime(device.last_seen_at, now, i18n.language) ?? t("devices.justNow")}
                    </td>
                    <td className="table__actions">
                      <button className="btn btn-small" type="button" onClick={() => setEditing(device)}>
                        {t("devices.edit")}
                      </button>
                      <button
                        className="btn btn-small"
                        type="button"
                        disabled={setEnabled.isPending}
                        onClick={() => setEnabled.mutate({ id: device.id, enabled: device.status !== "active" })}
                      >
                        {device.status === "active" ? t("devices.disable") : t("devices.enable")}
                      </button>
                      <button className="btn btn-small btn-danger" type="button" onClick={() => setDeleting(device)}>
                        {t("devices.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {setEnabled.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(setEnabled.error, t("errors.generic"))}
          </p>
        )}
        {clearBinding.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(clearBinding.error, t("errors.generic"))}
          </p>
        )}
      </section>

      <form className="panel" onSubmit={handleIdleSubmit} aria-labelledby="idle-heading">
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

      {editing && <EditDeviceDialog device={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          heading={t("devices.deleteHeading")}
          body={t("devices.deleteBody", { name: deleting.name })}
          confirmLabel={t("devices.delete")}
          cancelLabel={t("devices.cancel")}
          isPending={remove.isPending}
          error={remove.isError ? apiErrorMessage(remove.error, t("errors.generic")) : null}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
          onCancel={() => {
            remove.reset();
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
