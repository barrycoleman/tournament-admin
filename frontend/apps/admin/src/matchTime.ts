/** A match's time in the session's own timezone (never the browser's); UTC, labeled, when the session has none. */
export function formatMatchTime(
  iso: string,
  timeZone: string | null,
  includeDate: boolean,
  locale: string
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timeZone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (includeDate) {
    options.weekday = "short";
    options.month = "short";
    options.day = "numeric";
  }
  const text = new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  return timeZone ? text : `${text} UTC`;
}

export function spansMultipleDays(isos: string[], timeZone: string | null): boolean {
  const dayOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Set(isos.map((iso) => dayOf.format(new Date(iso)))).size > 1;
}
