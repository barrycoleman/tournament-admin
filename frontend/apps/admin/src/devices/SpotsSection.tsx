import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUDIENCE_SCREENS, apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DisplayRows, fieldSetNameOf } from "../displays/DisplayRows";
import { PitGroupEditor } from "../displays/PitGroupEditor";
import { ScreenSettingsEditor } from "../displays/ScreenSettingsEditor";
import type { DisplayGroupRead, DisplaysRead } from "../displays/types";
import { useDisplayMutations, type UnplacedDisplay } from "../displays/useDisplays";
import type { Division } from "../types";

/**
 * Every spot in one session: each field set's audience group and field
 * groups, the pit groups, the displays without a spot, and the displays a
 * copy couldn't place.
 */
export function SpotsSection({
  sessionId,
  data,
  unplaced,
}: {
  sessionId: number;
  data: DisplaysRead | undefined;
  unplaced: UnplacedDisplay[] | null;
}) {
  const { t } = useTranslation();
  const divisions = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const mutations = useDisplayMutations(sessionId);
  const [pitName, setPitName] = useState("");
  const [pitDivision, setPitDivision] = useState("");
  const [deleting, setDeleting] = useState<DisplayGroupRead | null>(null);

  const groups = data?.groups ?? [];
  const fieldSetName = fieldSetNameOf(groups);
  const audienceGroups = groups.filter((g) => g.kind === "audience");
  const pits = groups.filter((g) => g.kind === "pit");
  const failed = [mutations.createPit, mutations.updateGroup, mutations.deleteGroup].find((m) => m.isError);

  function addPit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    mutations.createPit.mutate(
      { name: pitName.trim(), division_id: pitDivision === "" ? null : Number(pitDivision) },
      { onSuccess: () => setPitName("") },
    );
  }

  return (
    <section aria-labelledby="spots-heading">
      <h2 id="spots-heading">{t("devicesDisplays.spotsHeading")}</h2>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}
      {unplaced && unplaced.length > 0 && (
        <div className="alert alert-warning" role="status">
          <p>{t("displays.unplacedHeading")}</p>
          <ul>
            {unplaced.map((u) => (
              <li key={u.device_id}>{t("displays.unplacedItem", { name: u.device_name, group: u.source_group_name })}</li>
            ))}
          </ul>
        </div>
      )}

      {audienceGroups.map((audience) => {
        const fieldGroups = groups.filter((g) => g.kind === "field" && g.field_set_id === audience.field_set_id);
        return (
          <section key={audience.id} className="panel" role="region" aria-label={audience.name}>
            <h3>{audience.name}</h3>
            <h4>{t("displays.audienceHeading")}</h4>
            <div className="field">
              <label className="field__label" htmlFor={`audience-screen-${audience.id}`}>
                {t("displays.audienceScreen")}
              </label>
              <select
                className="select"
                id={`audience-screen-${audience.id}`}
                value={audience.screen ?? ""}
                onChange={(e) => mutations.updateGroup.mutate({ groupId: audience.id, screen: e.target.value })}
              >
                {AUDIENCE_SCREENS.map((key) => (
                  <option key={key} value={key}>
                    {t(`displayScreens.${key}`)}
                  </option>
                ))}
              </select>
            </div>
            <ScreenSettingsEditor
              screen={audience.screen}
              kind="audience"
              settings={audience.screen_settings}
              idPrefix={`displays-audience-${audience.id}`}
              onChange={(settings) => mutations.updateGroup.mutate({ groupId: audience.id, screen_settings: settings })}
            />
            <label className="choice">
              <input
                type="checkbox"
                checked={audience.play_sounds}
                onChange={(e) => mutations.updateGroup.mutate({ groupId: audience.id, play_sounds: e.target.checked })}
              />{" "}
              {t("displays.playSounds")}
            </label>
            <DisplayRows
              displays={audience.displays}
              groups={groups}
              sessionId={sessionId}
              currentGroupId={audience.id}
              fieldSetName={fieldSetName}
            />
            {fieldGroups.map((fieldGroup) => (
              <div key={fieldGroup.id}>
                <h4>{fieldGroup.name}</h4>
                <DisplayRows
                  displays={fieldGroup.displays}
                  groups={groups}
                  sessionId={sessionId}
                  currentGroupId={fieldGroup.id}
                  fieldSetName={fieldSetName}
                />
              </div>
            ))}
          </section>
        );
      })}

      <section className="panel" aria-labelledby="pits-heading">
        <h3 id="pits-heading">{t("displays.pitsHeading")}</h3>
        <form className="toolbar" onSubmit={addPit}>
          <div className="field">
            <label className="field__label" htmlFor="pit-name">
              {t("displays.pitName")}
            </label>
            <input className="input" id="pit-name" value={pitName} onChange={(e) => setPitName(e.target.value)} />
          </div>
          {(divisions.data?.length ?? 0) > 1 && (
            <div className="field">
              <label className="field__label" htmlFor="pit-division">
                {t("displays.pitDivision")}
              </label>
              <select className="select" id="pit-division" value={pitDivision} onChange={(e) => setPitDivision(e.target.value)}>
                <option value="">{t("displays.allDivisions")}</option>
                {divisions.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button className="btn" type="submit" disabled={pitName.trim() === "" || mutations.createPit.isPending}>
            {t("displays.addPit")}
          </button>
        </form>
        {pits.map((pit) => (
          <section key={pit.id} className="panel" role="region" aria-label={pit.name}>
            <h4>{pit.name}</h4>
            <PitGroupEditor key={`${pit.id}-${JSON.stringify(pit.rotation)}`} group={pit} />
            <DisplayRows displays={pit.displays} groups={groups} sessionId={sessionId} currentGroupId={pit.id} fieldSetName={fieldSetName} />
            <button className="btn btn-small btn-danger" type="button" onClick={() => setDeleting(pit)}>
              {t("displays.delete")}
            </button>
          </section>
        ))}
      </section>

      {data && (
        <section className="panel" role="region" aria-label={t("displays.unassignedHeading")}>
          <h3>{t("displays.unassignedHeading")}</h3>
          <DisplayRows displays={data.unassigned} groups={groups} sessionId={sessionId} currentGroupId={null} fieldSetName={fieldSetName} />
        </section>
      )}

      {deleting && (
        <ConfirmDialog
          heading={t("displays.deleteHeading")}
          body={t("displays.deleteBody", { name: deleting.name })}
          confirmLabel={t("displays.delete")}
          cancelLabel={t("displays.cancel")}
          isPending={mutations.deleteGroup.isPending}
          onConfirm={() => mutations.deleteGroup.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
