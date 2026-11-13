import { useTranslation } from "react-i18next";
import type { DeviceRead, DeviceStatus } from "./useDevices";

const STATUS_BADGE: Record<DeviceStatus, string> = {
  active: "badge-success",
  idle: "badge-warning",
  disabled: "badge-neutral",
};

/** The active / idle / disabled badge. */
export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${STATUS_BADGE[status] ?? "badge-neutral"}`}>
      {t(`devices.status.${status}`, { defaultValue: status })}
    </span>
  );
}

/**
 * Edit, Enable/Disable and Delete for one device. An idle device counts as
 * not enabled, so only an active one offers Disable.
 */
export function DeviceActionButtons({
  device,
  toggling,
  onToggle,
  onEdit,
  onDelete,
}: {
  device: DeviceRead;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button className="btn btn-small" type="button" onClick={onEdit}>
        {t("devices.edit")}
      </button>
      <button className="btn btn-small" type="button" disabled={toggling} onClick={() => onToggle(device.status !== "active")}>
        {device.status === "active" ? t("devices.disable") : t("devices.enable")}
      </button>
      <button className="btn btn-small btn-danger" type="button" onClick={onDelete}>
        {t("devices.delete")}
      </button>
    </>
  );
}
