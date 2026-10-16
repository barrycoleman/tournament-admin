import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatClock } from "@tournament-admin/shared";
import { useServerNow } from "../serverClock";
import { ScreenFrame } from "./ScreenFrame";

/** While a time-out runs on the field group, shows its countdown instead of `children`. */
export function TimeoutGate({ deadline, children }: { deadline: string | null; children: ReactNode }) {
  const { t } = useTranslation();
  const now = useServerNow();
  const remainingMs = deadline === null ? 0 : Date.parse(deadline) - now;
  if (remainingMs <= 0) return <>{children}</>;
  return (
    <ScreenFrame title={t("display.timeout")} className="timeout">
      <p className="clock" data-testid="timeout-clock">
        {formatClock(remainingMs / 1000)}
      </p>
    </ScreenFrame>
  );
}
