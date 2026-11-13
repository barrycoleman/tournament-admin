import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { useNow } from "../orientation/useNow";
import { DeviceActionButtons, DeviceStatusBadge } from "./deviceCells";
import { relativeTime } from "./format";
import { useDeviceMutations, type DeviceRead } from "./useDevices";

/** Scorers, referees, judges and check-in devices, with a scorer's field binding. */
export function OtherDevicesTable({
  devices,
  onEdit,
  onDelete,
}: {
  devices: DeviceRead[];
  onEdit: (device: DeviceRead) => void;
  onDelete: (device: DeviceRead) => void;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(30_000).getTime();
  const { setEnabled, clearBinding } = useDeviceMutations();
  const failed = [setEnabled, clearBinding].find((m) => m.isError);

  if (devices.length === 0) return <p>{t("devicesDisplays.otherEmpty")}</p>;

  return (
    <>
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
            {devices.map((device) => (
              <tr key={device.id}>
                <td>{device.name}</td>
                <td>{t(`devices.roles.${device.role}`, { defaultValue: device.role })}</td>
                <td>
                  {device.binding && (
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
                  )}
                </td>
                <td>
                  <DeviceStatusBadge status={device.status} />
                </td>
                <td className="table__nowrap">{relativeTime(device.last_seen_at, now, i18n.language) ?? t("devices.justNow")}</td>
                <td className="table__actions">
                  <DeviceActionButtons
                    device={device}
                    toggling={setEnabled.isPending}
                    onToggle={(enabled) => setEnabled.mutate({ id: device.id, enabled })}
                    onEdit={() => onEdit(device)}
                    onDelete={() => onDelete(device)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}
    </>
  );
}
