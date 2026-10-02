import { useEffect, useState, type RefObject } from "react";
import type { DataGridHandle } from "react-data-grid";

/**
 * The grid's content-box width: its inner width, less its border and any
 * vertical scrollbar, which is the space its columns can share. Tracked
 * with a ResizeObserver, so it follows window resizes and the scrollbar
 * appearing once the rows outgrow the grid's height. 0 until measured.
 */
export function useContentWidth(gridRef: RefObject<DataGridHandle | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = gridRef.current?.element;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize?.[0];
      setWidth(Math.floor(box ? box.inlineSize : entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [gridRef]);
  return width;
}
