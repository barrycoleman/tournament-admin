import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useEventInfo } from "../api";

/** The compact frame table screens share: one heading row with the title left, a muted context on the right, and the event name small beside it. */
export function ScreenFrame({
  title,
  subtitle,
  context,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  context?: string;
  className?: string;
  children?: ReactNode;
}) {
  const event = useEventInfo();
  return (
    <section className={`screen ${className ?? ""}`}>
      <header className="screen__header">
        <h1 className="screen__title">{title}</h1>
        <p className="screen__event">{event.data?.name ?? ""}</p>
        {context ? (
          <p className="screen__context">{context}</p>
        ) : (
          subtitle && <p className="screen__subtitle">{subtitle}</p>
        )}
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
