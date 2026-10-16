import type { GroupKind, ScreenSettings } from "./types";

/** The server's screen registry (services/display_screens.py), in button order. */
export const SCREEN_KEYS = [
  "match_intro",
  "in_match",
  "last_scored_match",
  "teamwork_rankings",
  "skills_rankings",
  "upcoming_matches",
  "match_results",
  "schedule",
  "elimination_bracket",
  "logo",
] as const;
export type ScreenKey = (typeof SCREEN_KEYS)[number];

const AUDIENCE_ONLY: ReadonlySet<ScreenKey> = new Set(["match_intro", "in_match", "last_scored_match"]);
export const AUDIENCE_SCREENS: readonly ScreenKey[] = SCREEN_KEYS;
export const PIT_SCREENS: readonly ScreenKey[] = SCREEN_KEYS.filter((key) => !AUDIENCE_ONLY.has(key));
export const SCROLLING_SCREENS: ReadonlySet<ScreenKey> = new Set([
  "teamwork_rankings",
  "skills_rankings",
  "match_results",
  "schedule",
]);

export const ROTATION_SECONDS = { min: 5, max: 300, default: 20 } as const;
export const UPCOMING_COUNT = { min: 1, max: 20, default: 3 } as const;
export const TIMEOUT_SECONDS = { min: 10, max: 600, default: 180 } as const;

export function isScreenKey(value: unknown): value is ScreenKey {
  return typeof value === "string" && (SCREEN_KEYS as readonly string[]).includes(value);
}

export function screensFor(kind: GroupKind): readonly ScreenKey[] {
  if (kind === "audience") return AUDIENCE_SCREENS;
  if (kind === "pit") return PIT_SCREENS;
  return [];
}

export function defaultSettings(screen: ScreenKey, kind: GroupKind): ScreenSettings {
  if (screen !== "upcoming_matches") return {};
  return { count: UPCOMING_COUNT.default, scope: kind === "pit" ? "division" : "field_set" };
}
