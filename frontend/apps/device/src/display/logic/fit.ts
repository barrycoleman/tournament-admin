/** Scale (at most 1) that makes content of the given size fit inside the box. */
export function fitScale(contentWidth: number, contentHeight: number, boxWidth: number, boxHeight: number): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 1;
  return Math.min(1, boxWidth / contentWidth, boxHeight / contentHeight);
}
