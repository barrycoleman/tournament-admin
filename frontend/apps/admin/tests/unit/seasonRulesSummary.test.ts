import { describe, expect, it } from "vitest";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { describeSeasonRules } from "../../src/rankings/seasonRulesSummary";
import type { RankingSettingsValues } from "../../src/types";

const i18n = initI18n({ en: { translation: enAdmin } });
const DEFAULTS: RankingSettingsValues = {
  session_drop_mode: "tiered",
  session_drop_count: 1,
  session_drop_no_show: false,
  session_drop_dq: false,
  season_keep_best: null,
  season_only_session_counted: false,
  season_minimum: 0,
  season_drop_no_show: false,
  season_drop_dq: false,
};

describe("describeSeasonRules", () => {
  it("describes the defaults as a plain average", () => {
    expect(describeSeasonRules(i18n.t, DEFAULTS)).toBe("Average of every qualification match.");
  });

  it("joins every non-default rule", () => {
    expect(
      describeSeasonRules(i18n.t, {
        ...DEFAULTS,
        season_keep_best: 24,
        season_minimum: 24,
        season_only_session_counted: true,
      })
    ).toBe("Best 24 matches · minimum 24 · only matches counted in a session ranking");
  });

  it("uses the singular and capitalizes whichever rule comes first", () => {
    expect(describeSeasonRules(i18n.t, { ...DEFAULTS, season_keep_best: 1 })).toBe("Best 1 match");
    expect(describeSeasonRules(i18n.t, { ...DEFAULTS, season_minimum: 5 })).toBe("Minimum 5");
    expect(describeSeasonRules(i18n.t, { ...DEFAULTS, season_only_session_counted: true })).toBe(
      "Only matches counted in a session ranking"
    );
  });
});
