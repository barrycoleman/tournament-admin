import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";

export interface UnsavedChangesCopy {
  heading: string;
  body: string;
}

/**
 * Asks before leaving the page (or closing the tab) with unapplied changes;
 * returns the dialog to render. `copy` replaces the default wording about rounds.
 * A data router allows one blocker at a time, so a page calls this once.
 */
export function useUnsavedChangesGuard(dirty: boolean, copy?: UnsavedChangesCopy): ReactNode {
  const { t } = useTranslation();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (blocker.state !== "blocked") return null;
  return (
    <ConfirmDialog
      heading={copy?.heading ?? t("sessions.schedule.unsaved.heading")}
      body={copy?.body ?? t("sessions.schedule.unsaved.body")}
      confirmLabel={t("sessions.schedule.unsaved.leave")}
      cancelLabel={t("sessions.schedule.unsaved.stay")}
      onConfirm={() => blocker.proceed()}
      onCancel={() => blocker.reset()}
    />
  );
}
