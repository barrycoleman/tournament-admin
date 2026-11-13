import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

interface NextStepProps {
  /** A route to go to. Give this or `onClick`. */
  to?: string;
  onClick?: () => void;
  children: ReactNode;
}

/** A quiet "Next: ..." line that points at the step after the one just finished. */
export function NextStep({ to, onClick, children }: NextStepProps) {
  const { t } = useTranslation();
  return (
    <p className="next-step">
      <span className="next-step__label">{t("orientation.nextStep.label")}</span>{" "}
      {to !== undefined ? (
        <Link to={to}>{children}</Link>
      ) : (
        <button type="button" className="btn-link" onClick={onClick}>
          {children}
        </button>
      )}
    </p>
  );
}
