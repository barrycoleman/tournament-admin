import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import type { DisplayGroupRead, DisplayRef } from "./types";
import { useDisplayMutations } from "./useDisplays";

export function groupOptionLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  group: DisplayGroupRead,
  fieldSetName: (id: number | null) => string,
): string {
  if (group.kind === "audience") return t("displays.groupOption.audience", { name: group.name });
  if (group.kind === "field")
    return t("displays.groupOption.field", {
      fieldSet: fieldSetName(group.field_set_id),
      name: group.name,
    });
  return t("displays.groupOption.pit", { name: group.name });
}

/** A list of displays with Identify and a selector that moves each one. */
export function DisplayRows({
  displays,
  groups,
  sessionId,
  currentGroupId,
  fieldSetName,
}: {
  displays: DisplayRef[];
  groups: DisplayGroupRead[];
  sessionId: number;
  currentGroupId: number | null;
  fieldSetName: (id: number | null) => string;
}) {
  const { t } = useTranslation();
  const { assign, identify } = useDisplayMutations(sessionId);
  if (displays.length === 0) return <p className="table__secondary">{t("displays.noDisplays")}</p>;
  const failed = assign.isError ? assign.error : identify.isError ? identify.error : null;
  return (
    <>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed, t("errors.generic"))}
        </p>
      )}
      <ul className="list-plain">
        {displays.map((display) => (
          <li key={display.device_id} className="list-row">
            <span className="list-row__main">{display.name}</span>
            <span className={`badge ${display.online ? "badge-success" : "badge-neutral"}`}>
              {display.online ? t("displays.online") : t("displays.offline")}
            </span>
            <button
              className="btn btn-small"
              type="button"
              aria-label={t("displays.identifyNamed", { name: display.name })}
              onClick={() => identify.mutate(display.device_id)}
            >
              {t("displays.identify")}
            </button>
            <select
              className="select"
              aria-label={
                currentGroupId === null ? t("displays.putInGroup", { name: display.name }) : t("displays.moveNamed", { name: display.name })
              }
              value={currentGroupId === null ? "" : String(currentGroupId)}
              onChange={(event) =>
                assign.mutate({
                  deviceId: display.device_id,
                  groupId: event.target.value === "" ? null : Number(event.target.value),
                })
              }
            >
              <option value="">{currentGroupId === null ? t("displays.chooseGroup") : t("displays.unassign")}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {groupOptionLabel(t, group, fieldSetName)}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </>
  );
}
