import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useEventInfo } from "../api";

/** The kiosk frame every screen shares: the event name small, the screen's title large. */
export function ScreenFrame({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children?: ReactNode;
}) {
  const event = useEventInfo();
  return (
    <section className={`screen ${className ?? ""}`}>
      <header className="screen__header">
        <p className="screen__event">{event.data?.name ?? ""}</p>
        <h1 className="screen__title">{title}</h1>
        {subtitle && <p className="screen__subtitle">{subtitle}</p>}
      </header>
      <div className="screen__body">{children}</div>
    </section>
  );
}

export function ScreenNotice({ title, text }: { title: string; text: string }) {
  return (
    <ScreenFrame title={title}>
      <p className="screen__notice">{text}</p>
    </ScreenFrame>
  );
}

/** Shown while a screen's data is loading or being retried; never a blank TV. */
export function WaitingForData({ title }: { title: string }) {
  const { t } = useTranslation();
  return <ScreenNotice title={title} text={t("display.waiting")} />;
}
