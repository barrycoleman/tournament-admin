import { useRef, type ReactNode } from "react";
import { useAutoScroll } from "../useAutoScroll";

export function ScrollingList({
  onDone,
  fitSeconds,
  children,
}: {
  onDone?: () => void;
  fitSeconds?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useAutoScroll(ref, { onDone, fitSeconds });
  return (
    <div className="scroll-area" ref={ref}>
      {children}
    </div>
  );
}
