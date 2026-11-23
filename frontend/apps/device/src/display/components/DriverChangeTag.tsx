import { useTranslation } from "react-i18next";

/** The amber "Driver change" tag shown under the clock during the driver-change window. */
export function DriverChangeTag() {
  const { t } = useTranslation();
  return (
    <span className="driver-change" data-testid="driver-change">
      <svg className="driver-change__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 8h14l-4-4M20 16H6l4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {t("display.driverChange")}
    </span>
  );
}
