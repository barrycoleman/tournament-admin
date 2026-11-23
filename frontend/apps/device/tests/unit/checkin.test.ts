import { describe, expect, it } from "vitest";
import type { Participant, Team } from "../../src/display/api";
import { checkinSummary } from "../../src/display/logic/checkin";

const team = (id: number, number: string, division_id: number | null = 4): Team => ({ id, number, name: `T${id}`, division_id, city: null, state: null, country: null });
const part = (id: number, team_id: number, checked_in: boolean): Participant => ({ id, session_id: 1, team_id, checked_in });
const teams = new Map([team(1, "83897A"), team(2, "10A"), team(3, "9A"), team(4, "7Z", 5)].map((t) => [t.id, t]));
const all = () => true;
const inFour = (r: { division_id: number | null }) => r.division_id === 4;

describe("checkinSummary", () => {
  it("counts the teams checked in and lists them in team-number order", () => {
    const s = checkinSummary([part(1, 1, true), part(2, 2, false), part(3, 3, true)], teams, inFour);
    expect(s.checkedIn).toBe(2);
    expect(s.total).toBe(3);
    expect(s.rows.map((r) => [r.team.number, r.checkedIn])).toEqual([["9A", true], ["10A", false], ["83897A", true]]);
  });

  it("lists a team with no participation row as not checked in", () => {
    const s = checkinSummary([part(1, 1, true)], teams, inFour);
    expect(s.rows.map((r) => [r.team.number, r.checkedIn])).toEqual([["9A", false], ["10A", false], ["83897A", true]]);
    expect(s.checkedIn).toBe(1);
    expect(s.total).toBe(3);
  });

  it("lists every team, not checked in, before anyone has a participation row", () => {
    const s = checkinSummary([], teams, all);
    expect(s.total).toBe(4);
    expect(s.checkedIn).toBe(0);
    expect(s.rows.every((r) => !r.checkedIn)).toBe(true);
  });

  it("drops a team in another division, and does not count it", () => {
    const s = checkinSummary([part(1, 1, true), part(4, 4, true)], teams, inFour);
    expect(s.rows.map((r) => r.team.id)).toEqual([3, 2, 1]);
    expect(s.checkedIn).toBe(1);
    expect(s.total).toBe(3);
  });

  it("ignores a participant whose team is unknown", () => {
    const s = checkinSummary([part(1, 1, true), part(9, 99, true)], teams, all);
    expect(s.total).toBe(4);
    expect(s.checkedIn).toBe(1);
  });

  it("is empty when there are no teams at all", () => {
    const s = checkinSummary([part(1, 1, true)], new Map(), all);
    expect(s.rows).toEqual([]);
    expect(s.total).toBe(0);
  });
});
