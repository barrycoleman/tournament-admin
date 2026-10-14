import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import { PAIRABLE_ROLES, useDeviceMutations, type DeviceRead } from "./useDevices";

export function EditDeviceDialog({ device, onClose }: { device: DeviceRead; onClose: () => void }) {
  const { t } = useTranslation();
  const { update } = useDeviceMutations();
  const [name, setName] = useState(device.name);
  const [role, setRole] = useState(device.role);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await update.mutateAsync({ id: device.id, name, role }).catch(() => null);
    if (saved) onClose();
  }

  return (
    <Modal
      labelledBy="edit-device-heading"
      onCancel={() => {
        if (!update.isPending) onClose();
      }}
    >
      <form onSubmit={handleSubmit}>
        <h2 id="edit-device-heading">{t("devices.editHeading", { name: device.name })}</h2>
        <div className="field">
          <label className="field__label" htmlFor="edit-device-name">
            {t("devices.nameLabel")}
          </label>
          <input
            className="input"
            id="edit-device-name"
            value={name}
            maxLength={100}
            data-autofocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="edit-device-role">
            {t("devices.roleLabel")}
          </label>
          <select
            className="input"
            id="edit-device-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {PAIRABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`devices.roles.${r}`)}
              </option>
            ))}
          </select>
        </div>
        {update.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(update.error, t("errors.generic"))}
          </p>
        )}
        <div className="dialog__actions">
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || update.isPending}>
            {t("devices.save")}
          </button>
          <button className="btn" type="button" onClick={onClose} disabled={update.isPending}>
            {t("devices.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
