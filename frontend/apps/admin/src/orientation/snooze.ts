export const BANNER_SNOOZE_MS = 15 * 60 * 1000;

// Used when localStorage is unavailable (private mode, blocked storage), so
// "Not yet" still hides the banner for the life of the page.
const memory = new Map<string, number>();

const keyFor = (sessionId: number) => `orientation.bannerSnooze.${sessionId}`;

export function snoozeBanner(sessionId: number, now: Date): void {
  const key = keyFor(sessionId);
  const until = now.getTime() + BANNER_SNOOZE_MS;
  memory.set(key, until);
  try {
    localStorage.setItem(key, String(until));
  } catch {
    // The in-memory copy above is the fallback.
  }
}

export function isBannerSnoozed(sessionId: number, now: Date): boolean {
  const key = keyFor(sessionId);
  let until = memory.get(key) ?? 0;
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > until) until = stored;
  } catch {
    // Fall back to the in-memory value.
  }
  return now.getTime() < until;
}
