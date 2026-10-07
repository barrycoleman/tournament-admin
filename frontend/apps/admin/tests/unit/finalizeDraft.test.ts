import { describe, expect, it } from "vitest";
import { draftFromRows, validateDraft } from "../../src/qualification/finalizeDraft";

const ROWS = [
  { played: 7, teams: 4, suggested: 1 },
  { played: 8, teams: 12, suggested: 2 },
];

describe("finalizeDraft", () => {
  it("starts from the suggestions", () => {
    expect(draftFromRows(ROWS)).toEqual({ "7": "1", "8": "2" });
  });

  it("turns a valid draft into the drops body", () => {
    expect(validateDraft(ROWS, { "7": "0", "8": "3" })).toEqual({ drops: { "7": 0, "8": 3 }, errors: {} });
  });

  it("flags blank, fractional, negative and too-large values", () => {
    const result = validateDraft(ROWS, { "7": "", "8": "8" });
    expect(result.drops).toBeNull();
    expect(result.errors).toEqual({ "7": { max: 6 }, "8": { max: 7 } });
    expect(validateDraft(ROWS, { "7": "1.5", "8": "2" }).errors).toEqual({ "7": { max: 6 } });
    expect(validateDraft(ROWS, { "7": "-1", "8": "2" }).errors).toEqual({ "7": { max: 6 } });
  });

  it("accepts an empty row list (head-to-head)", () => {
    expect(validateDraft([], {})).toEqual({ drops: {}, errors: {} });
  });
});
