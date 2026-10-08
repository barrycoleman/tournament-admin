import type { SkillsSettingsRead } from "../types";

export interface SkillsSettingsDraft {
  enabled: boolean;
  /** Type key -> the text in its attempts box. */
  attempts: Record<string, string>;
}

const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 20;

export function toSkillsDraft(settings: SkillsSettingsRead): SkillsSettingsDraft {
  return {
    enabled: settings.enabled,
    attempts: Object.fromEntries(settings.types.map((type) => [type.key, String(settings.attempts[type.key] ?? 3)])),
  };
}

function isValidAttempts(text: string): boolean {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const value = Number(trimmed);
  return value >= MIN_ATTEMPTS && value <= MAX_ATTEMPTS;
}

/** The keys whose text isn't a whole number from 1 to 20. */
export function attemptsErrors(attempts: Record<string, string>): Set<string> {
  return new Set(Object.entries(attempts).filter(([, text]) => !isValidAttempts(text)).map(([key]) => key));
}

/** The attempts as numbers, or null while any is invalid. */
export function parseAttempts(attempts: Record<string, string>): Record<string, number> | null {
  if (attemptsErrors(attempts).size > 0) return null;
  return Object.fromEntries(Object.entries(attempts).map(([key, text]) => [key, Number(text.trim())]));
}
