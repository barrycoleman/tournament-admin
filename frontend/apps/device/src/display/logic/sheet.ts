/** A scoresheet value for a TV: a tick for yes, a dash for nothing. */
export function formatSheetValue(value: unknown): string {
  if (value === true) return "✓";
  if (value === false || value === null || value === undefined || value === "") return "–";
  return String(value);
}
