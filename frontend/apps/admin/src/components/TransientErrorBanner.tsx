import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  dismissTransientError,
  getTransientError,
  subscribeTransientError,
} from "../errorBanner";

export function TransientErrorBanner() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<string | null>(getTransientError());

  useEffect(() => subscribeTransientError(setMessage), []);

  if (!message) return null;

  return (
    <div role="alert">
      <p>{message}</p>
      <button onClick={dismissTransientError}>{t("shell.dismiss")}</button>
    </div>
  );
}
