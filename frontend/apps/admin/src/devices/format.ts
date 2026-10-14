/** A pairing code as the server stores it: no spaces or hyphens, upper case. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** "3 min ago" style text in the page's language; null under a minute. */
export function relativeTime(iso: string, now: number, locale: string): string | null {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return null;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}
