import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopySpotsPanel } from "../devices/CopySpotsPanel";
import { DisplaysTable } from "../devices/DisplaysTable";
import { EditDeviceDialog } from "../devices/EditDeviceDialog";
import { IdleTimeoutForm } from "../devices/IdleTimeoutForm";
import { OtherDevicesTable } from "../devices/OtherDevicesTable";
import { PairDeviceForm } from "../devices/PairDeviceForm";
import { ServerInfoPanel } from "../devices/ServerInfoPanel";
import { SpotsSection } from "../devices/SpotsSection";
import { DEVICES_KEY, useDeviceMutations, useDevices, type DeviceRead } from "../devices/useDevices";
import { useDisplays, type UnplacedDisplay } from "../displays/useDisplays";
import { orderSessions } from "../orientation/sessionTime";
import { useEvent, useSessions } from "../orientation/useOrientationData";

/**
 * Pairing, every TV and what it shows, the spots of one session, and the
 * other devices. The "Spots for" picker changes only this page's view; the
 * TVs themselves follow the event's active session.
 */
export function DevicesDisplaysRoute() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const event = useEvent();
  const sessions = useSessions();
  const devices = useDevices();
  const { remove } = useDeviceMutations();
  const ordered = orderSessions(sessions.data ?? []);
  const activeId = event.data?.active_session_id ?? null;
  const [chosen, setChosen] = useState<number | null>(null);
  const sessionId = chosen ?? activeId ?? ordered[0]?.id ?? null;
  const displays = useDisplays(sessionId);
  const [unplaced, setUnplaced] = useState<UnplacedDisplay[] | null>(null);
  const [editing, setEditing] = useState<DeviceRead | null>(null);
  const [deleting, setDeleting] = useState<DeviceRead | null>(null);

  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (message) => {
      if (message.event === "devices_changed" || message.event === "scorer_binding_changed") {
        void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      }
    },
  });

  const tvs = devices.data?.filter((d) => d.role === "display_device") ?? [];
  const others = devices.data?.filter((d) => d.role !== "display_device") ?? [];
  const otherSessions = ordered.filter((s) => s.id !== sessionId);
  const fixLink = ordered[0] ? `/sessions/${ordered[0].id}/today` : "/sessions/new";

  return (
    <div>
      <div className="toolbar toolbar--filters">
        <h1>{t("devicesDisplays.heading")}</h1>
        <span className="toolbar__spacer" />
        <div className="field">
          <label className="field__label" htmlFor="displays-session">
            {t("devicesDisplays.spotsFor")}
          </label>
          <select
            className="select"
            id="displays-session"
            value={sessionId ?? ""}
            onChange={(e) => {
              setChosen(e.target.value === "" ? null : Number(e.target.value));
              setUnplaced(null);
            }}
          >
            {ordered.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === activeId ? t("displays.activeSession", { label: s.label }) : s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {event.data && activeId === null && sessions.data && (
        <div className="alert alert-warning" role="status">
          {t("devicesDisplays.noActiveWarning")}{" "}
          <Link to={fixLink}>{ordered[0] ? t("devicesDisplays.noActiveLink") : t("devicesDisplays.noSessionsLink")}</Link>
        </div>
      )}

      <ServerInfoPanel />
      <PairDeviceForm initialCode={params.get("pair") ?? ""} sessionId={sessionId} />

      <section className="panel" aria-labelledby="tvs-heading">
        <h2 id="tvs-heading">{t("devicesDisplays.tvsHeading")}</h2>
        {devices.isError && (
          <p className="alert alert-danger" role="alert">
            {t("devices.loadError")}
          </p>
        )}
        {devices.data && (
          <DisplaysTable devices={tvs} displays={displays.data} sessionId={sessionId} onEdit={setEditing} onDelete={setDeleting} />
        )}
        {sessionId !== null && otherSessions.length > 0 && (
          <CopySpotsPanel key={sessionId} sessionId={sessionId} otherSessions={otherSessions} onCopied={setUnplaced} />
        )}
      </section>

      {sessionId !== null && <SpotsSection sessionId={sessionId} data={displays.data} unplaced={unplaced} />}

      <section className="panel" aria-labelledby="others-heading">
        <h2 id="others-heading">{t("devicesDisplays.otherHeading")}</h2>
        {devices.data && <OtherDevicesTable devices={others} onEdit={setEditing} onDelete={setDeleting} />}
      </section>

      <IdleTimeoutForm />

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
