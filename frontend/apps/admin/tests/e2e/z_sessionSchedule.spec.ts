import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";
import { buildBalancedSchedulerPluginZip, buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

// The "z_" filename prefix is deliberate: this spec adds ~40 teams to the shared
// event (teams can't be deleted once checked in), and the team-grid specs
// (team*.spec.ts) assume a small roster whose new row is visible without
// scrolling. Playwright runs files in name order, so this one runs after them
// (and so beforeAll below has to undo the extra divisions those specs leave).
let token = "";
const headers = () => ({ Authorization: `Bearer ${token}` });

async function uploadPlugin(request: APIRequestContext, endpoint: string, zipPath: string) {
  const response = await request.post(endpoint, {
    headers: headers(),
    multipart: {
      file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(zipPath) },
    },
  });
  expect([201, 409]).toContain(response.status());
}

interface ReadySession {
  sessionId: number;
  teamIds: number[];
}

async function createReadySession(
  request: APIRequestContext,
  label: string,
  teamPrefix: string,
  divisionName: string | null = null
): Promise<ReadySession> {
  const session = await (
    await request.post("/api/sessions", {
      headers: headers(),
      data: { label, session_date: "2026-11-07", timezone: "America/Los_Angeles" },
    })
  ).json();
  const rows = Array.from({ length: 8 }, (_, i) => ({
    number: `${teamPrefix}${i + 1}`,
    name: `${label} Team ${i + 1}`,
    division: divisionName,
  }));
  const bulk = await (await request.post("/api/teams/bulk", { headers: headers(), data: { rows } })).json();
  const teamIds: number[] = bulk.results.map((result: { team: { id: number } }) => result.team.id);
  for (const teamId of teamIds) {
    await request.post(`/api/sessions/${session.id}/participants`, {
      headers: headers(),
      data: { team_id: teamId, checked_in: true },
    });
  }
  return { sessionId: session.id, teamIds };
}

async function addField(request: APIRequestContext, sessionId: number, name: string) {
  const response = await request.post("/api/fields", { headers: headers(), data: { session_id: sessionId, name } });
  expect(response.ok()).toBeTruthy();
}

async function setWindows(request: APIRequestContext, sessionId: number, windows: [string, string, string][]) {
  const response = await request.put(`/api/sessions/${sessionId}/playing-windows`, {
    headers: headers(),
    data: { windows: windows.map(([date, start_time, end_time]) => ({ date, start_time, end_time })) },
  });
  expect(response.ok()).toBeTruthy();
}

async function scheduleViaApi(request: APIRequestContext, sessionId: number, rounds: [string, number][]) {
  const response = await request.post("/api/schedule", {
    headers: headers(),
    data: {
      session_id: sessionId,
      scheduler_plugin_name: "balanced",
      rounds: rounds.map(([round_type, target_matches_per_team]) => ({ round_type, target_matches_per_team, cycle_time_seconds: 240 })),
    },
  });
  expect(response.status()).toBe(201);
}

async function scoreFirstMatch(request: APIRequestContext, sessionId: number, roundType: string) {
  const matches = await (await request.get(`/api/matches?session_id=${sessionId}`, { headers: headers() })).json();
  const match = matches.find((m: { round_type: string }) => m.round_type === roundType);
  for (const alliance of match.alliances) {
    const scored = await request.post(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
      headers: headers(),
      data: { data: { high_balls: 5, low_balls: 2, auto_winner: "tie" } },
    });
    expect(scored.ok()).toBeTruthy();
  }
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
}

test.describe.serial("session fields, schedule, and matches", () => {
  let main: ReadySession;

  test.beforeAll(async ({ request }) => {
    const created = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(created.status());
    const login = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    token = (await login.json()).access_token;

    await uploadPlugin(request, "/api/plugins/schedulers", await buildBalancedSchedulerPluginZip());
    const event = await (await request.get("/api/event")).json();
    if (event.game_plugin_name === null) {
      await uploadPlugin(request, "/api/plugins/games", await buildExampleGamePluginZip());
      const selected = await request.post("/api/event/game-plugin", {
        headers: headers(),
        data: { name: "example-game" },
      });
      expect(selected.ok()).toBeTruthy();
    }

    // Earlier specs (the randomize spec) leave extra divisions behind. These tests
    // start from a single-division event, so drop all but the first; deleting a
    // division just unassigns its teams.
    const divisions = await (await request.get("/api/divisions", { headers: headers() })).json();
    for (const extra of divisions.slice(1)) {
      const removed = await request.delete(`/api/divisions/${extra.id}`, { headers: headers() });
      expect(removed.ok()).toBeTruthy();
    }

    main = await createReadySession(request, "Schedule E2E", "SCH");
  });

  test("set playing times, generate across a break, and see the times in Matches", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);
    await page.getByLabel("Add your first field").fill("Field A");
    await page.getByRole("button", { name: "Add field", exact: true }).click();
    const card = page.getByRole("region", { name: "Main Fields" });
    await expect(card.getByText("Field A")).toBeVisible();
    await card.getByLabel("New field name for Main Fields").fill("Field B");
    await card.getByRole("button", { name: "Add field", exact: true }).click();
    await expect(card.getByText("Field B")).toBeVisible();

    await page.getByRole("link", { name: "Schedule" }).click();
    const blockers = page.getByRole("region", { name: "Can't schedule yet" });
    await expect(blockers.getByRole("link", { name: "Add playing times" })).toBeVisible();

    await page.getByLabel("Playing time 1 date").fill("2026-11-07");
    await page.getByLabel("Playing time 1 start").fill("09:00");
    await page.getByLabel("Playing time 1 end").fill("09:15");
    await page.getByRole("button", { name: "Add playing time" }).click();
    await page.getByLabel("Playing time 2 start").fill("10:00");
    await page.getByLabel("Playing time 2 end").fill("12:00");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Sat 09:00–09:15, 10:00–12:00")).toBeVisible();
    await expect(blockers).toHaveCount(0);

    await expect(page.getByLabel("Practice matches per team")).toHaveValue("1");
    await expect(page.getByLabel("Qualification matches per team")).toHaveValue("6");
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();
    // Qualification can't all fit before 09:15, so it continues after the break.
    const qualificationRow = page.getByRole("row", { name: /Qualification/ });
    await expect(qualificationRow).toContainText(/10:\d\d/);

    await page.getByRole("link", { name: "View matches" }).click();
    await expect(page.getByRole("gridcell", { name: "P1", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "09:00", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "10:00", exact: true })).toBeVisible();
  });

  test("an edit that overflows is fixed with the suggested cycle time and applied", async ({ page, request }) => {
    const session = await createReadySession(request, "Overflow E2E", "OVF");
    await addField(request, session.sessionId, "Overflow Field");
    await setWindows(request, session.sessionId, [["2026-11-07", "09:00", "11:00"]]);
    await scheduleViaApi(request, session.sessionId, [["qualification", 4]]);

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    // 25 per team on one field is 50 slots: about 3 h 20 min at 4:00, in a 2-hour window.
    await page.getByLabel("Qualification matches per team").fill("25");
    await expect(page.getByText("changed")).toBeVisible();
    await expect(page.getByText(/^⚠ Over by/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    await page.getByRole("button", { name: /^Use cycle time / }).click();
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();
    await expect(page.getByText("changed")).toHaveCount(0);
  });

  test("an edit that overflows is fixed by extending the day", async ({ page, request }) => {
    const session = await createReadySession(request, "Extend E2E", "EXT");
    await addField(request, session.sessionId, "Extend Field");
    await setWindows(request, session.sessionId, [["2026-11-07", "09:00", "10:00"]]);
    await scheduleViaApi(request, session.sessionId, [["qualification", 2]]);

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    await page.getByLabel("Qualification matches per team").fill("12");
    await page.getByRole("button", { name: /^Extend Sat to / }).click();
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    // The timeline repeats the window as a label, so read the panel's summary.
    await expect(
      page.getByRole("region", { name: "Playing times" }).getByText(/^Sat 09:00–1\d:\d\d$/).first()
    ).toBeVisible();
    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();
  });

  test("Practice and Qualification flow across lunch and into the second day", async ({ page, request }) => {
    const session = await createReadySession(request, "Two Day E2E", "TWD");
    await addField(request, session.sessionId, "Two Day Field");
    // A short Saturday morning, lunch, a short afternoon, then Sunday: the
    // 14 default matches (4:00 apart on one field) can't all fit on Saturday.
    await setWindows(request, session.sessionId, [
      ["2026-11-07", "09:00", "09:20"],
      ["2026-11-07", "13:00", "13:20"],
      ["2026-11-08", "09:00", "12:00"],
    ]);

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    await expect(page.getByLabel("Practice matches per team")).toHaveValue("1");
    await expect(page.getByLabel("Qualification matches per team")).toHaveValue("6");
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();

    // The Qualification round starts on Saturday and ends on Sunday.
    const qualificationRow = page.getByRole("row", { name: /Qualification/ });
    await expect(qualificationRow).toContainText(/Sat, Nov 7, \d\d:\d\d – Sun, Nov 8, \d\d:\d\d/);

    // The Matches tab spans two days, so it labels every time with its day.
    await page.getByRole("link", { name: "View matches" }).click();
    await expect(page.getByRole("gridcell", { name: "P1", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Sat, Nov 7, 09:00", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Sat, Nov 7, 13:00", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Sun, Nov 8, 09:00", exact: true })).toBeVisible();
  });

  test("a scored round is locked while the round after it stays editable", async ({ page, request }) => {
    const session = await createReadySession(request, "Locked E2E", "LCK");
    await addField(request, session.sessionId, "Locked Field");
    await setWindows(request, session.sessionId, [["2026-11-07", "09:00", "17:00"]]);
    await scheduleViaApi(request, session.sessionId, [["practice", 1], ["qualification", 2]]);
    await scoreFirstMatch(request, session.sessionId, "practice");

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    await expect(page.getByText("1 scored")).toBeVisible();
    await expect(page.getByLabel("Practice matches per team")).toHaveCount(0);
    await expect(page.getByLabel("Qualification matches per team")).toBeEditable();

    await page.getByRole("button", { name: "Clear Practice" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Clear" })).toBeDisabled();
    await dialog.getByLabel('Type "Practice" to confirm').fill("Practice");
    await dialog.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Clear Practice" })).toHaveCount(0);
  });

  test("leaving with unapplied changes asks first", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/schedule`);
    await page.getByLabel("Qualification matches per team").fill("7");
    await page.getByRole("link", { name: "Matches", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Leave without applying?")).toBeVisible();
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${main.sessionId}/schedule$`));
    await expect(page.getByLabel("Qualification matches per team")).toHaveValue("7");
  });

  test("deleting a field that has matches shows the server's refusal", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);
    await page.getByRole("button", { name: "Remove field Field A" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("region", { name: "Main Fields" }).getByRole("alert")).toHaveText(
      "Field has scheduled matches; clear the schedule first"
    );
  });

  test("the checklist blocks generating when the division has no fields", async ({ page, request }) => {
    const bare = await createReadySession(request, "No Fields E2E", "NOF");
    await setWindows(request, bare.sessionId, [["2026-11-07", "09:00", "12:00"]]);
    await loginAsAdmin(page);
    await page.goto(`/sessions/${bare.sessionId}/schedule`);
    const blockers = page.getByRole("region", { name: "Can't schedule yet" });
    await expect(blockers.getByRole("listitem")).toHaveCount(1);
    await expect(blockers.getByRole("link", { name: "Add fields" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  test("two divisions each generate on their own field set", async ({ page, request }) => {
    const divisions = await (await request.get("/api/divisions", { headers: headers() })).json();
    expect(divisions).toHaveLength(1);
    const first = divisions[0];
    const second = await (
      await request.post("/api/divisions", { headers: headers(), data: { name: "E2E Blue" } })
    ).json();
    const sessionA = await createReadySession(request, "Two Div E2E", "TDA", first.name);
    const sessionId = sessionA.sessionId;
    const blueTeams = Array.from({ length: 8 }, (_, i) => ({
      number: `TDB${i + 1}`,
      name: `Blue Team ${i + 1}`,
      division: second.name,
    }));
    const bulk = await (await request.post("/api/teams/bulk", { headers: headers(), data: { rows: blueTeams } })).json();
    for (const result of bulk.results) {
      await request.post(`/api/sessions/${sessionId}/participants`, {
        headers: headers(),
        data: { team_id: result.team.id, checked_in: true },
      });
    }
    const setIds: number[] = [];
    for (const [name, divisionId] of [
      ["Gym A", first.id],
      ["Gym B", second.id],
    ] as const) {
      const set = await (
        await request.post("/api/field-sets", {
          headers: headers(),
          data: { session_id: sessionId, name, division_id: divisionId },
        })
      ).json();
      setIds.push(set.id);
      await request.post("/api/fields", {
        headers: headers(),
        data: { session_id: sessionId, name: `${name} Field 1`, field_set_id: set.id },
      });
    }
    await setWindows(request, sessionId, [["2026-11-07", "09:00", "17:00"]]);

    try {
      await loginAsAdmin(page);
      await page.goto(`/sessions/${sessionId}/schedule`);
      await expect(page.getByRole("tab", { name: "E2E Blue · 8 teams" })).toBeVisible();
      await page.getByRole("tab", { name: new RegExp(`^${first.name} · `) }).click();
      await expect(page.getByText(/^✓ Fits/)).toBeVisible();
      await page.getByRole("button", { name: "Generate" }).click();
      await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();

      await page.getByRole("tab", { name: new RegExp(`^${second.name} · `) }).click();
      await expect(page.getByLabel("Practice matches per team")).toHaveValue("1");
      await expect(page.getByText(/^✓ Fits/)).toBeVisible();
      await page.getByRole("button", { name: "Generate" }).click();
      await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();

      await page.getByRole("link", { name: "Matches", exact: true }).click();
      await page.getByLabel("Division").selectOption(String(second.id));
      await expect(page.getByRole("gridcell", { name: "Q1", exact: true })).toBeVisible();
    } finally {
      // Put the shared event back to one division for every later spec.
      for (const divisionId of [first.id, second.id]) {
        for (const roundType of ["practice", "qualification"]) {
          await request.delete(
            `/api/schedule?session_id=${sessionId}&division_id=${divisionId}&round_type=${roundType}`,
            { headers: headers() }
          );
        }
      }
      for (const setId of setIds) {
        await request.delete(`/api/field-sets/${setId}`, { headers: headers() });
      }
      await request.delete(`/api/divisions/${second.id}`, { headers: headers() });
    }
  });
});
