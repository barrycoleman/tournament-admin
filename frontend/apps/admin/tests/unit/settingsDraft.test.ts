import { describe, expect, it } from "vitest";
import { draftErrors, toBody, toDraft, type SettingsDraft } from "../../src/rankings/settingsDraft";
import type { RankingSettingsValues } from "../../src/types";

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

const draft = (changes: Partial<SettingsDraft> = {}): SettingsDraft => ({ ...toDraft(DEFAULTS), ...changes });

describe("settingsDraft", () => {
  it("turns settings into text fields and back", () => {
    expect(toDraft(DEFAULTS)).toEqual({
      mode: "tiered",
      dropCount: "1",
      sessionNoShow: false,
      sessionDq: false,
      keepBest: "",
      onlySessionCounted: false,
      minimum: "0",
      seasonNoShow: false,
      seasonDq: false,
    });
    expect(toBody(toDraft(DEFAULTS))).toEqual(DEFAULTS);
  });

  it("accepts valid input, trimming spaces", () => {
    expect(draftErrors(draft())).toEqual({});
    expect(draftErrors(draft({ mode: "lowest", dropCount: " 3 ", keepBest: " 24 ", minimum: "" }))).toEqual({});
    expect(toBody(draft({ mode: "lowest", dropCount: " 3 ", keepBest: " 24 ", minimum: "" }))).toMatchObject({
      session_drop_count: 3,
      season_keep_best: 24,
      season_minimum: 0,
    });
  });

  it("checks the drop count only when dropping a set number", () => {
    expect(draftErrors(draft({ mode: "lowest", dropCount: "0" }))).toEqual({ dropCount: "dropCount" });
    expect(draftErrors(draft({ mode: "tiered", dropCount: "0" }))).toEqual({});
    expect(toBody(draft({ mode: "tiered", dropCount: "0" })).session_drop_count).toBe(1);
  });

  it("rejects decimals, negatives and zero kept matches", () => {
    expect(draftErrors(draft({ keepBest: "2.5" }))).toEqual({ keepBest: "keepBest" });
    expect(draftErrors(draft({ keepBest: "0" }))).toEqual({ keepBest: "keepBest" });
    expect(draftErrors(draft({ minimum: "-1" }))).toEqual({ minimum: "minimum" });
  });

  it("rejects a minimum above the kept matches", () => {
    expect(draftErrors(draft({ keepBest: "2", minimum: "3" }))).toEqual({ minimum: "minimumAboveKeepBest" });
    expect(draftErrors(draft({ keepBest: "", minimum: "3" }))).toEqual({});
  });
});
