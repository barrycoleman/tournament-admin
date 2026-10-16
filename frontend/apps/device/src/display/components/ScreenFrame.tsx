import { useEffect, useRef, type ReactNode } from "react";
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

/** In a rotation a scrolling screen showing a notice has no list to scroll,
 * so it reports done after `fitSeconds` and the rotation moves on. */
export function ScreenNotice({
  title,
  text,
  onDone,
  fitSeconds,
}: {
  title: string;
  text: string;
  onDone?: () => void;
  fitSeconds?: number;
}) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const timed = onDone !== undefined && fitSeconds !== undefined;
  useEffect(() => {
    if (!timed) return;
    const id = setTimeout(() => onDoneRef.current?.(), fitSeconds * 1000);
    return () => clearTimeout(id);
  }, [timed, fitSeconds]);
  return (
    <ScreenFrame title={title}>
      <p className="screen__notice">{text}</p>
    </ScreenFrame>
  );
}

/** Shown while a screen's data is loading or being retried; never a blank TV. */
export function WaitingForData({ title, onDone, fitSeconds }: { title: string; onDone?: () => void; fitSeconds?: number }) {
  const { t } = useTranslation();
  return <ScreenNotice title={title} text={t("display.waiting")} onDone={onDone} fitSeconds={fitSeconds} />;
}
