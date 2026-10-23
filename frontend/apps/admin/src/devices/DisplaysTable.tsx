import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { fieldSetNameOf, groupOptionLabel } from "../displays/DisplayRows";
import type { DisplaysRead } from "../displays/types";
import { useDisplayMutations } from "../displays/useDisplays";
import { useNow } from "../orientation/useNow";
import { DeviceActionButtons, DeviceStatusBadge } from "./deviceCells";
import { relativeTime } from "./format";
import { useDeviceMutations, type DeviceRead } from "./useDevices";

interface Placement {
  online: boolean;
  groupId: number | null;
}

/** Where each display sits in the session, and whether it is connected now. */
function placements(displays: DisplaysRead | undefined): Map<number, Placement> {
  const byDevice = new Map<number, Placement>();
  for (const group of displays?.groups ?? []) {
    for (const display of group.displays) byDevice.set(display.device_id, { online: display.online, groupId: group.id });
  }
  for (const display of displays?.unassigned ?? []) byDevice.set(display.device_id, { online: display.online, groupId: null });
  return byDevice;
}

/**
 * One row per paired TV: what it shows in the chosen session, its live
 * connection beside its status, and its actions. A TV the displays read
 * doesn't list counts as not connected.
 */
export function DisplaysTable({
  devices,
  displays,
  sessionId,
  onEdit,
  onDelete,
}: {
  devices: DeviceRead[];
  displays: DisplaysRead | undefined;
  sessionId: number | null;
  onEdit: (device: DeviceRead) => void;
  onDelete: (device: DeviceRead) => void;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(30_000).getTime();
  const { setEnabled } = useDeviceMutations();
  const { assign, identify } = useDisplayMutations(sessionId);
  const groups = displays?.groups ?? [];
  const fieldSetName = fieldSetNameOf(groups);
  const byDevice = placements(displays);
  const failed = [setEnabled, assign, identify].find((m) => m.isError);

  if (devices.length === 0) return <p>{t("devicesDisplays.tvsEmpty")}</p>;

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t("devices.columns.name")}</th>
              <th scope="col">{t("devicesDisplays.columns.shows")}</th>
              <th scope="col">{t("devicesDisplays.columns.connection")}</th>
              <th scope="col">{t("devices.columns.status")}</th>
              <th scope="col">{t("devices.columns.lastSeen")}</th>
              <th scope="col" className="table__actions">
                {t("devices.columns.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => {
              const placement = byDevice.get(device.id);
              const online = placement?.online ?? false;
              return (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>
                    <select
                      className="select"
                      aria-label={t("devicesDisplays.showsNamed", { name: device.name })}
                      value={placement?.groupId == null ? "" : String(placement.groupId)}
                      disabled={sessionId === null || assign.isPending}
                      onChange={(event) =>
                        assign.mutate({
                          deviceId: device.id,
                          groupId: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                    >
                      <option value="">{t("devicesDisplays.nothingYet")}</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {groupOptionLabel(t, group, fieldSetName)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`table__nowrap ${online ? "connection connection--on" : "connection"}`}>
                    {online ? t("devicesDisplays.connected") : t("devicesDisplays.notConnected")}
                  </td>
                  <td>
                    <DeviceStatusBadge status={device.status} />
                  </td>
                  <td className="table__nowrap">{relativeTime(device.last_seen_at, now, i18n.language) ?? t("devices.justNow")}</td>
                  <td className="table__actions">
                    <button
                      className="btn btn-small"
                      type="button"
                      aria-label={t("displays.identifyNamed", { name: device.name })}
                      disabled={!online}
                      title={online ? undefined : t("displays.identifyOffline")}
                      onClick={() => {
                        if (online) identify.mutate(device.id);
                      }}
                    >
                      {t("displays.identify")}
                    </button>
                    <DeviceActionButtons
                      device={device}
                      toggling={setEnabled.isPending}
                      onToggle={(enabled) => setEnabled.mutate({ id: device.id, enabled })}
                      onEdit={() => onEdit(device)}
                      onDelete={() => onDelete(device)}
                    />
                  </td>
                </tr>
              );
            })}
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
