import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { IdentifyButton } from "./IdentifyButton";
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

/** Names a field set by its audience group, for `groupOptionLabel`. */
export function fieldSetNameOf(groups: DisplayGroupRead[]): (id: number | null) => string {
  return (id) => groups.find((g) => g.kind === "audience" && g.field_set_id === id)?.name ?? "";
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
  const failed = assign.isError ? assign.error : identify.isError ? identify.error : null;
  const alert = failed && (
    <p className="alert alert-danger" role="alert">
      {apiErrorMessage(failed, t("errors.generic"))}
    </p>
  );
  if (displays.length === 0)
    return (
      <>
        {alert}
        <p className="table__secondary">{t("displays.noDisplays")}</p>
      </>
    );
  return (
    <>
      {alert}
      <ul className="list-plain">
        {displays.map((display) => (
          <li key={display.device_id} className="list-row">
            <span className="list-row__main">{display.name}</span>
            <span className={`badge ${display.online ? "badge-success" : "badge-neutral"}`}>
              {display.online ? t("displays.online") : t("displays.offline")}
            </span>
            <IdentifyButton
              name={display.name}
              online={display.online}
              onIdentify={() => identify.mutate(display.device_id)}
            />
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
