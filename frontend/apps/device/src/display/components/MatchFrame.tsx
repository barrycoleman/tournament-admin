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

/** "PREFIX · TITLE" in capitals, an optional muted field, and anything the screen wants at the right. */
export function BottomBar({ title, field, prefix, end }: { title: string; field?: string; prefix?: string; end?: ReactNode }) {
  return (
    <footer className="bottom-bar" data-testid="bottom-bar">
      <p className="bottom-bar__id">
        {prefix ? `${prefix} · ${title}` : title}
        {field && <span className="bottom-bar__field"> · {field}</span>}
      </p>
      {end !== undefined && <div className="bottom-bar__end">{end}</div>}
    </footer>
  );
}
