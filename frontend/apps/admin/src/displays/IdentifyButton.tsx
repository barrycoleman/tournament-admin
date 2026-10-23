import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Identify for one TV. An offline TV keeps the button usable, so keyboard
 * and touch users can reach it, and answers a press with a visible note
 * instead of calling the API.
 */
export function IdentifyButton({
  name,
  online,
  onIdentify,
}: {
  name: string;
  online: boolean;
  onIdentify: () => void;
}) {
  const { t } = useTranslation();
  const [triedOffline, setTriedOffline] = useState(false);
  return (
    <>
      <button
        className="btn btn-small"
        type="button"
        aria-label={t("displays.identifyNamed", { name })}
        onClick={() => {
          if (online) {
            setTriedOffline(false);
            onIdentify();
          } else {
            setTriedOffline(true);
          }
        }}
      >
        {t("displays.identify")}
      </button>
      <span className="table__secondary" role="status">
        {triedOffline && !online ? t("displays.identifyOffline") : null}
      </span>
    </>
  );
}
