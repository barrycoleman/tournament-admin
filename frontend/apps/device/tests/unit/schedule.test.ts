import { describe, expect, it } from "vitest";
import {
  compareTeamNumbers,
  isOnFieldNow,
  nextMatchesForTeam,
  onFieldMatchIds,
  roundProgress,
  scheduleRows,
  fieldName,
} from "../../src/display/logic/schedule";
import { match } from "./displayFixtures";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 7, 16, minutes)).toISOString();
const done = (id: number, extra = {}) => match({ id, label: `Q${id}`, status: "completed", phase: "ended", scheduled_time: at(id), ...extra });
const open = (id: number, extra = {}) => match({ id, label: `Q${id}`, scheduled_time: at(id), ...extra });
const labels = (rows: { label: string }[]) => rows.map((r) => r.label);

describe("scheduleRows", () => {
  it("starts two played matches before the earliest unplayed one", () => {
    const rows = scheduleRows([done(1), done(2), done(3), open(4), open(5)]);
    expect(labels(rows)).toEqual(["Q2", "Q3", "Q4", "Q5"]);
  });
  it("returns the whole list when every match is played", () => {
    expect(labels(scheduleRows([done(1), done(2), done(3)]))).toEqual(["Q1", "Q2", "Q3"]);
  });
  it("starts at the top when fewer than two are played", () => {
    expect(labels(scheduleRows([done(1), open(2)]))).toEqual(["Q1", "Q2"]);
  });
  it("drops not_played matches and sorts the rest", () => {
    const skipped = match({ id: 9, label: "Q9", status: "not_played", scheduled_time: at(0) });
    expect(labels(scheduleRows([open(3), skipped, open(2)]))).toEqual(["Q2", "Q3"]);
  });
  it("takes the lead as a parameter", () => {
    expect(labels(scheduleRows([done(1), done(2), open(3)], 1))).toEqual(["Q2", "Q3"]);
  });
});

describe("onFieldMatchIds and isOnFieldNow", () => {
  const q4 = open(4, { field_id: 1, phase: "match", status: "in_progress" });
  const q5 = open(5, { field_id: 2 });
  const q6 = open(6, { field_id: 2 });
  it("finds the running match for one field and the next unplayed for another", () => {
    const ids = onFieldMatchIds([done(1), q4, q5, q6, open(7, { field_id: 1 })], [1, 2]);
    expect([...ids].sort()).toEqual([4, 5]);
  });
  it("tags a running match and an ended-but-unscored one only", () => {
    expect(isOnFieldNow(q4)).toBe(true);
    expect(isOnFieldNow(open(8, { phase: "ended", status: "scheduled" }))).toBe(true);
    expect(isOnFieldNow(done(1))).toBe(false);
    expect(isOnFieldNow(q5)).toBe(false);
  });
});

describe("roundProgress", () => {
  it("counts played over total in the earliest unplayed match's round", () => {
    expect(roundProgress([done(1), done(2), done(3), open(4), open(5)])).toEqual({ round: "qualification", played: 3, total: 5 });
  });
  it("moves to qualification, 0 of N, when practice is done", () => {
    const practice = [done(1, { round_type: "practice" }), done(2, { round_type: "practice" })];
    expect(roundProgress([...practice, open(3), open(4)])).toEqual({ round: "qualification", played: 0, total: 2 });
  });
  it("calls finals elimination", () => {
    const finals = open(9, { round_type: "finals", scheduled_time: null });
    expect(roundProgress([done(1), finals])?.round).toBe("elimination");
  });
  it("is null when nothing is unplayed", () => {
    expect(roundProgress([done(1), done(2)])).toBeNull();
  });
});

describe("fieldName", () => {
  const fields = [{ id: 7, field_set_id: 1, name: "Sharks" }, { id: 3, field_set_id: 1, name: "Jets" }];
  it("uses every field's own name, long or short", () => {
    expect(fieldName(fields, 7)).toBe("Sharks");
    expect(fieldName(fields, 3)).toBe("Jets");
  });
  it("is empty for no field or an unknown one", () => {
    expect(fieldName(fields, null)).toBe("");
    expect(fieldName(fields, 99)).toBe("");
  });
});

describe("compareTeamNumbers", () => {
  it("orders digits numerically", () => {
    expect(compareTeamNumbers("9A", "10A")).toBeLessThan(0);
    expect(compareTeamNumbers("10A", "10a")).toBe(0);
  });
});

describe("nextMatchesForTeam", () => {
  it("returns at most three unfinished matches for the team, in order", () => {
    const all = [done(1), open(5), open(2), open(3), open(4), match({ id: 6, label: "Q6", status: "not_played" }), open(7, { alliances: [{ id: 1, station: "red", team_ids: [50] }, { id: 2, station: "blue", team_ids: [51] }] })];
    expect(labels(nextMatchesForTeam(all, 1))).toEqual(["Q2", "Q3", "Q4"]);
    expect(labels(nextMatchesForTeam(all, 50))).toEqual(["Q7"]);
    expect(labels(nextMatchesForTeam(all, 1, 5))).toEqual(["Q2", "Q3", "Q4", "Q5"]);
  });
});
