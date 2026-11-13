import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { useDisplayMutations, type UnplacedDisplay } from "../displays/useDisplays";
import type { SessionRead } from "../types";

/**
 * Copies another session's spots into `sessionId`. Remount it (key by
 * session) to clear the chosen source when the page's session changes.
 */
export function CopySpotsPanel({
  sessionId,
  otherSessions,
  onCopied,
}: {
  sessionId: number;
  otherSessions: SessionRead[];
  onCopied: (unplaced: UnplacedDisplay[]) => void;
}) {
  const { t } = useTranslation();
  const { copy } = useDisplayMutations(sessionId);
  const [copyFrom, setCopyFrom] = useState("");

  return (
    <section className="panel" role="region" aria-label={t("devicesDisplays.copyHeading")}>
      <h3>{t("devicesDisplays.copyHeading")}</h3>
      <p>{t("displays.copyHelp")}</p>
      <div className="toolbar">
        <div className="field">
          <label className="field__label" htmlFor="copy-from">
            {t("displays.copyFrom")}
          </label>
          <select className="select" id="copy-from" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">{t("displays.chooseSession")}</option>
            {otherSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn"
          type="button"
          disabled={copyFrom === "" || copy.isPending}
          onClick={() => copy.mutate(Number(copyFrom), { onSuccess: (result) => onCopied(result.unplaced) })}
        >
          {t("displays.copyAction")}
        </button>
      </div>
      {copy.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(copy.error, t("errors.generic"))}
        </p>
      )}
    </section>
  );
}
