import { useEffect } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useOutletContext } from "react-router-dom";
import { SessionSettingsForm } from "../sessions/SessionSettingsForm";
import type { SessionRead } from "../types";
import { SessionFieldsPanel } from "./SessionFieldsRoute";

/** The session's own settings, then its fields; a #hash scrolls to and focuses the matching part. */
export function SessionSetupRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const { hash } = useLocation();
  const loading = useIsFetching() > 0;

  useEffect(() => {
    if (loading || !hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!target) return;
    target.scrollIntoView();
    const control = target.matches("input, select, button, textarea")
      ? target
      : target.querySelector<HTMLElement>("input, select, button, textarea");
    (control ?? target).focus({ preventScroll: true });
  }, [hash, loading]);

  return (
    <div>
      <h1>{t("sessions.setup.heading")}</h1>
      <SessionSettingsForm session={session} />
      <h2>{t("sessions.setup.fieldsHeading")}</h2>
      <SessionFieldsPanel />
    </div>
  );
}
