import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUDIENCE_SCREENS, apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DisplayRows } from "../displays/DisplayRows";
import { PitGroupEditor } from "../displays/PitGroupEditor";
import { ScreenSettingsEditor } from "../displays/ScreenSettingsEditor";
import type { DisplayGroupRead } from "../displays/types";
import { useDisplayMutations, useDisplays, type UnplacedDisplay } from "../displays/useDisplays";
import type { Division, EventRead, SessionRead } from "../types";

export function DisplaysRoute() {
  const { t } = useTranslation();
  const event = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const divisions = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const [chosen, setChosen] = useState<number | null>(null);
  const sessionId = chosen ?? event.data?.active_session_id ?? sessions.data?.[0]?.id ?? null;
  const displays = useDisplays(sessionId);
  const mutations = useDisplayMutations(sessionId);
  const [pitName, setPitName] = useState("");
  const [pitDivision, setPitDivision] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [unplaced, setUnplaced] = useState<UnplacedDisplay[] | null>(null);
  const [deleting, setDeleting] = useState<DisplayGroupRead | null>(null);

  const data = displays.data;
  const groups = data?.groups ?? [];
  const fieldSetName = (id: number | null) => groups.find((g) => g.kind === "audience" && g.field_set_id === id)?.name ?? "";
  const audienceGroups = groups.filter((g) => g.kind === "audience");
  const pits = groups.filter((g) => g.kind === "pit");
  const failed = Object.values(mutations).find((m) => m.isError);

  function addPit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    mutations.createPit.mutate(
      {
        name: pitName.trim(),
        division_id: pitDivision === "" ? null : Number(pitDivision),
      },
      { onSuccess: () => setPitName("") },
    );
  }

  return (
    <div>
      <h1>{t("displays.heading")}</h1>
      <div className="field">
        <label className="field__label" htmlFor="displays-session">
          {t("displays.session")}
        </label>
        <select
          className="select"
          id="displays-session"
          value={sessionId ?? ""}
          onChange={(e) => {
            setChosen(e.target.value === "" ? null : Number(e.target.value));
            setCopyFrom("");
            setUnplaced(null);
          }}
        >
          {sessions.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === event.data?.active_session_id ? t("displays.activeSession", { label: s.label }) : s.label}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}

      {data && !data.has_setup && (
        <section className="panel" role="region" aria-label={t("displays.copyHeading")}>
          <h2>{t("displays.copyHeading")}</h2>
          <p>{t("displays.copyHelp")}</p>
          <div className="toolbar">
            <div className="field">
              <label className="field__label" htmlFor="copy-from">
                {t("displays.copyFrom")}
              </label>
              <select className="select" id="copy-from" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">{t("displays.chooseSession")}</option>
                {sessions.data
                  ?.filter((s) => s.id !== sessionId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
              </select>
            </div>
            <button
              className="btn"
              type="button"
              disabled={copyFrom === "" || Number(copyFrom) === sessionId || mutations.copy.isPending}
              onClick={() =>
                mutations.copy.mutate(Number(copyFrom), {
                  onSuccess: (result) => setUnplaced(result.unplaced),
                })
              }
            >
              {t("displays.copyAction")}
            </button>
          </div>
        </section>
      )}
      {unplaced && unplaced.length > 0 && (
        <div className="alert alert-warning" role="status">
          <p>{t("displays.unplacedHeading")}</p>
          <ul>
            {unplaced.map((u) => (
              <li key={u.device_id}>
                {t("displays.unplacedItem", {
                  name: u.device_name,
                  group: u.source_group_name,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sessionId !== null &&
        audienceGroups.map((audience) => {
          const fieldGroups = groups.filter((g) => g.kind === "field" && g.field_set_id === audience.field_set_id);
          return (
            <section key={audience.id} className="panel" role="region" aria-label={audience.name}>
              <h2>{audience.name}</h2>
              <h3>{t("displays.audienceHeading")}</h3>
              <div className="field">
                <label className="field__label" htmlFor={`audience-screen-${audience.id}`}>
                  {t("displays.audienceScreen")}
                </label>
                <select
                  className="select"
                  id={`audience-screen-${audience.id}`}
                  value={audience.screen ?? ""}
                  onChange={(e) =>
                    mutations.updateGroup.mutate({
                      groupId: audience.id,
                      screen: e.target.value,
                    })
                  }
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
                onChange={(settings) =>
                  mutations.updateGroup.mutate({
                    groupId: audience.id,
                    screen_settings: settings,
                  })
                }
              />
              <label className="choice">
                <input
                  type="checkbox"
                  checked={audience.play_sounds}
                  onChange={(e) =>
                    mutations.updateGroup.mutate({
                      groupId: audience.id,
                      play_sounds: e.target.checked,
                    })
                  }
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
                  <h3>{fieldGroup.name}</h3>
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

      {sessionId !== null && (
        <section className="panel" aria-labelledby="pits-heading">
          <h2 id="pits-heading">{t("displays.pitsHeading")}</h2>
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
              <h3>{pit.name}</h3>
              <PitGroupEditor key={`${pit.id}-${JSON.stringify(pit.rotation)}`} group={pit} />
              <DisplayRows
                displays={pit.displays}
                groups={groups}
                sessionId={sessionId}
                currentGroupId={pit.id}
                fieldSetName={fieldSetName}
              />
              <button className="btn btn-small btn-danger" type="button" onClick={() => setDeleting(pit)}>
                {t("displays.delete")}
              </button>
            </section>
          ))}
        </section>
      )}

      {data && sessionId !== null && (
        <section className="panel" role="region" aria-label={t("displays.unassignedHeading")}>
          <h2>{t("displays.unassignedHeading")}</h2>
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
          onConfirm={() =>
            mutations.deleteGroup.mutate(deleting.id, {
              onSuccess: () => setDeleting(null),
            })
          }
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
