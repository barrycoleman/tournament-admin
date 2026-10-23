import { describe, expect, it } from "vitest";
import {
  checkEventSetup,
  checkSessionReadiness,
  nextSessionStep,
  type SessionReadinessItem,
} from "../../src/orientation/readiness";
import type {
  FieldRead,
  FieldSetRead,
  MatchFormat,
  MatchRead,
  ParticipationRead,
  SessionRead,
  TeamSummary,
} from "../../src/types";

const session: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-10-24",
  timezone: "America/Chicago",
  has_scored_matches: false,
  qualification_finalized_at: null,
  qualification_drops: null,
};
const format: MatchFormat = {
  round_types: ["qualification"],
  teams_per_alliance: 1,
  alliance_count: 2,
  match_duration_seconds: 150,
  default_cycle_time_seconds: null,
};

function fieldSet(id: number, divisionId: number | null): FieldSetRead {
  return { id, session_id: 1, name: `Set ${id}`, division_id: divisionId, purpose: "teamwork" };
}
function field(id: number, fieldSetId: number): FieldRead {
  return { id, field_set_id: fieldSetId, name: `Field ${id}` };
}
function team(id: number, divisionId: number | null): TeamSummary {
  return { id, number: String(id), name: `Team ${id}`, division_id: divisionId };
}
function checkedIn(teamId: number): ParticipationRead {
  return { id: teamId, session_id: 1, team_id: teamId, checked_in: true };
}
function match(id: number, divisionId: number | null, isFinals = false): MatchRead {
  return {
    id,
    session_id: 1,
    division_id: divisionId,
    round_type: "qualification",
    match_number: id,
    label: `Q${id}`,
    field_id: null,
    time_slot: null,
    scheduled_time: null,
    status: "scheduled",
    is_finals: isFinals,
    alliances: [],
  };
}

type Input = Parameters<typeof checkSessionReadiness>[0];
function readyInput(over: Partial<Input> = {}): Input {
  return {
    session,
    activeSessionId: 1,
    divisions: [{ id: 1 }],
    teams: [team(1, 1), team(2, 1)],
    participants: [checkedIn(1), checkedIn(2)],
    fieldSets: [fieldSet(1, null)],
    fields: [field(1, 1)],
    windowCount: 1,
    matches: [match(1, null)],
    matchFormat: format,
    displayCount: 1,
    ...over,
  };
}
function byKey(items: SessionReadinessItem[]) {
  return Object.fromEntries(items.map((i) => [i.key, i]));
}

describe("checkEventSetup", () => {
  it("is all false on an empty event", () => {
    expect(checkEventSetup({ gamePluginSelected: false, teamCount: 0, sessionCount: 0 })).toEqual([
      { key: "gamePlugin", ok: false },
      { key: "teams", ok: false },
      { key: "session", ok: false },
    ]);
  });
  it("is all true when filled", () => {
    const items = checkEventSetup({ gamePluginSelected: true, teamCount: 4, sessionCount: 1 });
    expect(items.every((i) => i.ok)).toBe(true);
  });
});

describe("checkSessionReadiness", () => {
  it("returns the items in order", () => {
    expect(checkSessionReadiness(readyInput()).map((i) => i.key)).toEqual([
      "timezone", "fields", "playingTimes", "teams", "schedule", "active", "displays",
    ]);
  });

  it("is all ok for a fully set-up single-division session", () => {
    expect(checkSessionReadiness(readyInput()).every((i) => i.ok)).toBe(true);
  });

  it("uses the unassigned field sets for a single division", () => {
    const items = byKey(checkSessionReadiness(readyInput({ fieldSets: [fieldSet(1, 1)] })));
    expect(items.fields.ok).toBe(false);
  });

  it("fails fields when one division of several has none", () => {
    const items = byKey(
      checkSessionReadiness(
        readyInput({
          divisions: [{ id: 1 }, { id: 2 }],
          teams: [team(1, 1), team(2, 1), team(3, 2), team(4, 2)],
          participants: [1, 2, 3, 4].map(checkedIn),
          fieldSets: [fieldSet(1, 1)],
          fields: [field(1, 1)],
          matches: [match(1, 1), match(2, 2)],
        })
      )
    );
    expect(items.fields.ok).toBe(false);
    expect(items.teams.ok).toBe(true);
    expect(items.schedule.ok).toBe(true);
  });

  it("fails teams when a division is short of checked-in teams", () => {
    const items = byKey(
      checkSessionReadiness(
        readyInput({
          divisions: [{ id: 1 }, { id: 2 }],
          teams: [team(1, 1), team(2, 1), team(3, 2), team(4, 2)],
          participants: [1, 2, 3].map(checkedIn),
        })
      )
    );
    expect(items.teams.ok).toBe(false);
  });

  it("needs a non-finals match in every division for schedule", () => {
    const multi = { divisions: [{ id: 1 }, { id: 2 }] };
    expect(byKey(checkSessionReadiness(readyInput({ ...multi, matches: [] }))).schedule.ok).toBe(false);
    expect(byKey(checkSessionReadiness(readyInput({ ...multi, matches: [match(1, 1)] }))).schedule.ok).toBe(false);
    expect(
      byKey(checkSessionReadiness(readyInput({ ...multi, matches: [match(1, 1), match(2, 2, true)] }))).schedule.ok
    ).toBe(false);
    expect(
      byKey(checkSessionReadiness(readyInput({ ...multi, matches: [match(1, 1), match(2, 2)] }))).schedule.ok
    ).toBe(true);
  });

  it("fails teams without a match format", () => {
    expect(byKey(checkSessionReadiness(readyInput({ matchFormat: null }))).teams.ok).toBe(false);
  });

  it("checks timezone, playing times and the active session", () => {
    const items = byKey(
      checkSessionReadiness(
        readyInput({ session: { ...session, timezone: null }, windowCount: 0, activeSessionId: 2 })
      )
    );
    expect(items.timezone.ok).toBe(false);
    expect(items.playingTimes.ok).toBe(false);
    expect(items.active.ok).toBe(false);
  });

  it("never treats displays as blocking", () => {
    for (const displayCount of [0, 2]) {
      const items = checkSessionReadiness(readyInput({ displayCount }));
      expect(items.filter((i) => !i.blocking).map((i) => i.key)).toEqual(["displays"]);
      expect(byKey(items).displays.ok).toBe(displayCount > 0);
    }
  });
});

describe("nextSessionStep", () => {
  const items = (failing: string[]): SessionReadinessItem[] =>
    ["timezone", "fields", "playingTimes", "teams", "schedule", "active", "displays"].map((key) => ({
      key: key as SessionReadinessItem["key"],
      ok: !failing.includes(key),
      blocking: key !== "displays",
    }));

  it("returns setup when timezone or fields fail", () => {
    expect(nextSessionStep(items(["timezone"]))).toBe("setup");
    expect(nextSessionStep(items(["fields", "teams"]))).toBe("setup");
  });
  it("returns planMatches when playing times, teams or schedule fail", () => {
    expect(nextSessionStep(items(["playingTimes"]))).toBe("planMatches");
    expect(nextSessionStep(items(["teams", "active"]))).toBe("planMatches");
    expect(nextSessionStep(items(["schedule"]))).toBe("planMatches");
  });
  it("returns makeActive when only active fails", () => {
    expect(nextSessionStep(items(["active", "displays"]))).toBe("makeActive");
  });
  it("returns matchControl when everything blocking passes", () => {
    expect(nextSessionStep(items([]))).toBe("matchControl");
    expect(nextSessionStep(items(["displays"]))).toBe("matchControl");
  });
});
