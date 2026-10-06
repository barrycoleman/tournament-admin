import type { RankingSettingsValues, SessionDropMode } from "../types";

/** The settings form as typed: numbers stay text until saved. */
export interface SettingsDraft {
  mode: SessionDropMode;
  dropCount: string;
  sessionNoShow: boolean;
  sessionDq: boolean;
  keepBest: string;
  onlySessionCounted: boolean;
  minimum: string;
  seasonNoShow: boolean;
  seasonDq: boolean;
}

/** Field -> the key of its message under rankings.settings.errors. */
export type DraftErrors = Partial<
  Record<"dropCount" | "keepBest" | "minimum", "dropCount" | "keepBest" | "minimum" | "minimumAboveKeepBest">
>;

function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function toDraft(settings: RankingSettingsValues): SettingsDraft {
  return {
    mode: settings.session_drop_mode,
    dropCount: String(settings.session_drop_count),
    sessionNoShow: settings.session_drop_no_show,
    sessionDq: settings.session_drop_dq,
    keepBest: settings.season_keep_best === null ? "" : String(settings.season_keep_best),
    onlySessionCounted: settings.season_only_session_counted,
    minimum: String(settings.season_minimum),
    seasonNoShow: settings.season_drop_no_show,
    seasonDq: settings.season_drop_dq,
  };
}

export function draftErrors(draft: SettingsDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.mode === "lowest") {
    const dropCount = parseWhole(draft.dropCount);
    if (dropCount === null || dropCount < 1) errors.dropCount = "dropCount";
  }
  let keepBest: number | null = null;
  if (draft.keepBest.trim() !== "") {
    keepBest = parseWhole(draft.keepBest);
    if (keepBest === null || keepBest < 1) {
      errors.keepBest = "keepBest";
      keepBest = null;
    }
  }
  const minimum = draft.minimum.trim() === "" ? 0 : parseWhole(draft.minimum);
  if (minimum === null) errors.minimum = "minimum";
  else if (keepBest !== null && minimum > keepBest) errors.minimum = "minimumAboveKeepBest";
  return errors;
}

/** Only call once draftErrors(draft) is empty. */
export function toBody(draft: SettingsDraft): RankingSettingsValues {
  const dropCount = parseWhole(draft.dropCount);
  return {
    session_drop_mode: draft.mode,
    // The server always needs a count of 1 or more, even when it's unused.
    session_drop_count: dropCount !== null && dropCount >= 1 ? dropCount : 1,
    session_drop_no_show: draft.sessionNoShow,
    session_drop_dq: draft.sessionDq,
    season_keep_best: draft.keepBest.trim() === "" ? null : (parseWhole(draft.keepBest) as number),
    season_only_session_counted: draft.onlySessionCounted,
    season_minimum: draft.minimum.trim() === "" ? 0 : (parseWhole(draft.minimum) as number),
    season_drop_no_show: draft.seasonNoShow,
    season_drop_dq: draft.seasonDq,
  };
}
