import { useLayoutEffect, useRef, type ReactNode } from "react";
import { fitScale } from "../logic/fit";

/** Fills its parent, centres its content at its natural size, and shrinks it (never grows it) to fit. */
export function FitText({ className, testId, children }: { className?: string; testId?: string; children: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const boxEl = box.current;
    const innerEl = inner.current;
    if (!boxEl || !innerEl) return;
    const measure = () => {
      // offset sizes ignore transforms, so they give the natural size.
      const s = fitScale(innerEl.offsetWidth, innerEl.offsetHeight, boxEl.clientWidth, boxEl.clientHeight);
      innerEl.style.transform = s < 1 ? `scale(${s})` : "";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(boxEl);
    observer.observe(innerEl);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span ref={box} className={className ? `fit-text ${className}` : "fit-text"} data-testid={testId}>
      <span ref={inner} className="fit-text__inner">{children}</span>
    </span>
  );
}

/** One line of text that keeps its natural size and shrinks (never grows) to its box's width instead of wrapping. */
export function FitLine({ align = "start", className, testId, children }: { align?: "start" | "end"; className?: string; testId?: string; children: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const boxEl = box.current;
    const innerEl = inner.current;
    if (!boxEl || !innerEl) return;
    const measure = () => {
      const s = fitScale(innerEl.offsetWidth, 1, boxEl.clientWidth, 1);
      innerEl.style.transform = s < 1 ? `scale(${s})` : "";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(boxEl);
    observer.observe(innerEl);
    return () => observer.disconnect();
  }, [children]);

  const classes = ["fit-line", `fit-line--${align}`, className].filter(Boolean).join(" ");
  return (
    <span ref={box} className={classes} data-testid={testId}>
      <span ref={inner} className="fit-line__inner">{children}</span>
    </span>
  );
}
