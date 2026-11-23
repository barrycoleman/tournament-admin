import type { ReactNode } from "react";

/** The frame match screens share: no header, a body that fills, and a bottom bar. */
export function MatchFrame({ className, bottom, children }: { className?: string; bottom: ReactNode; children?: ReactNode }) {
  return (
    <section className={`screen match-frame ${className ?? ""}`}>
      <div className="match-frame__body">{children}</div>
      {bottom}
    </section>
  );
}

/** "PREFIX · TITLE" in capitals, an optional muted field, and anything the
 * screen wants at the right. Given `start`, the bar splits in three: `start`
 * on the left, the title centred, `end` on the right. */
export function BottomBar({
  title,
  field,
  prefix,
  start,
  end,
}: {
  title: string;
  field?: string;
  prefix?: string;
  start?: ReactNode;
  end?: ReactNode;
}) {
  const split = start !== undefined;
  return (
    <footer className={split ? "bottom-bar bottom-bar--split" : "bottom-bar"} data-testid="bottom-bar">
      {split && <div className="bottom-bar__start">{start}</div>}
      <p className="bottom-bar__id">
        {prefix ? `${prefix} · ${title}` : title}
        {field && <span className="bottom-bar__field"> · {field}</span>}
      </p>
      {(split || end !== undefined) && <div className="bottom-bar__end">{end}</div>}
    </footer>
  );
}
