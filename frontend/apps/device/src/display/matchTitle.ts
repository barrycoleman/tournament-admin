import type { TFunction } from "i18next";
import type { LiveMatch } from "@tournament-admin/shared";

/** "Qualification 37", "Practice 4", or "Final F2-1" for a finals game. */
export function matchTitle(t: TFunction, match: LiveMatch): string {
  if (match.is_finals) return t("display.round.finals", { label: match.label });
  return t(`display.round.${match.round_type}`, { number: match.match_number, defaultValue: match.label });
}
