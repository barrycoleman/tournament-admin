import type { TFunction } from "i18next";

/**
 * The display name for a game plugin's round type. The standard types are
 * translated; one a plugin invents falls back to its own name, capitalized
 * ("round_robin" → "Round robin"). The raw value is still what the API takes.
 */
export function roundTypeLabel(t: TFunction, roundType: string): string {
  const spaced = roundType.replace(/_/g, " ");
  return t(`roundTypes.${roundType}`, { defaultValue: spaced.charAt(0).toUpperCase() + spaced.slice(1) });
}
