import type { TFunction } from "i18next";

/** A whole-minute duration, rounded up: "16 min", "2 h", "2 h 13 min". */
export function formatDuration(t: TFunction, seconds: number): string {
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t("sessions.schedule.duration.minutes", { minutes });
  if (minutes === 0) return t("sessions.schedule.duration.hours", { hours });
  return t("sessions.schedule.duration.hoursMinutes", { hours, minutes });
}
