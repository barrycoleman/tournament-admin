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

  test("set up fields, preview, generate, view matches, clear all, and regenerate", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: "Preview" })).toBeEnabled();
    await expect(page.getByRole("region", { name: "Can't schedule yet" })).toHaveCount(0);

    await page.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("region", { name: "Preview" });
    await expect(preview.getByText(/^Practice: \d+ matches$/)).toBeVisible();
    await expect(preview.getByText(/^Qualification: \d+ matches$/)).toBeVisible();
    await page.getByLabel("End time for block 1").fill("13:00");
    await expect(page.getByText("Out of date — preview again")).toBeVisible();

    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText(/^Generated \d+ matches\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear Practice" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();

    await page.getByRole("link", { name: "View matches" }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${main.sessionId}/matches$`));
    await expect(page.getByRole("gridcell", { name: "P1", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "09:00", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Schedule" }).click();
    await page.getByRole("button", { name: "Clear all rounds" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("No rounds have been generated yet.")).toBeVisible();

    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Clear Practice" })).toBeVisible();
  });

  test("a scored round needs its name typed before Clear works", async ({ page, request }) => {
    const matches = await (
      await request.get(`/api/matches?session_id=${main.sessionId}`, { headers: headers() })
    ).json();
    const practice = matches.find((m: { round_type: string }) => m.round_type === "practice");
    for (const alliance of practice.alliances) {
      const scored = await request.post(`/api/matches/${practice.id}/alliances/${alliance.id}/score`, {
        headers: headers(),
        data: { data: { high_balls: 5, low_balls: 2, auto_winner: "tie" } },
      });
      expect(scored.ok()).toBeTruthy();
    }

    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/schedule`);
    await page.getByRole("button", { name: "Clear Practice" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Clear" })).toBeDisabled();
    await dialog.getByLabel('Type "Practice" to confirm').fill("Practice");
    await dialog.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Clear Practice" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();
  });

  test("deleting a field that has matches shows the server's refusal", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);
    await page.getByRole("button", { name: "Remove field Field A" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("region", { name: "Main Fields" }).getByRole("alert")
    ).toHaveText("Field has scheduled matches; clear the schedule first");
  });

  test("the checklist blocks generating when the division has no fields", async ({ page, request }) => {
    const bare = await createReadySession(request, "No Fields E2E", "NOF");
    await loginAsAdmin(page);
    await page.goto(`/sessions/${bare.sessionId}/schedule`);
    const blockers = page.getByRole("region", { name: "Can't schedule yet" });
    await expect(blockers.getByRole("listitem")).toHaveCount(1);
    await expect(blockers.getByRole("link", { name: "Add fields" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  test("a fixed cycle time is entered as minutes and seconds", async ({ page, request }) => {
    const fixed = await createReadySession(request, "Fixed Cycle E2E", "FXC");
    const set = await (
      await request.post("/api/field-sets", {
        headers: headers(),
        data: { session_id: fixed.sessionId, name: "Cycle Fields", division_id: null },
      })
    ).json();
    await request.post("/api/fields", {
      headers: headers(),
      data: { session_id: fixed.sessionId, name: "Cycle Field 1", field_set_id: set.id },
    });

    await loginAsAdmin(page);
    await page.goto(`/sessions/${fixed.sessionId}/schedule`);
    await page.getByLabel("Fixed cycle time").check();
    const cycle = page.getByRole("group", { name: "Cycle time" });
    await cycle.getByLabel("Cycle time minutes").fill("7");
    await cycle.getByLabel("Cycle time seconds").fill("30");
    await page.getByLabel("End time for block 1").fill("");

    await page.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("region", { name: "Preview" });
    await expect(preview.getByRole("cell", { name: "7:30", exact: true })).toBeVisible();

    await cycle.getByLabel("Cycle time seconds").fill("75");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(
      page.getByText("Enter the cycle time as whole minutes and seconds, with seconds from 0 to 59.")
    ).toBeVisible();
  });

  test("a new round can start as soon as an open-ended round's matches finish", async ({ page, request }) => {
    const back = await createReadySession(request, "Back To Back E2E", "B2B");
    const set = await (
      await request.post("/api/field-sets", {
        headers: headers(),
        data: { session_id: back.sessionId, name: "B2B Fields", division_id: null },
      })
    ).json();
    await request.post("/api/fields", {
      headers: headers(),
      data: { session_id: back.sessionId, name: "B2B Field 1", field_set_id: set.id },
    });

    await loginAsAdmin(page);
    await page.goto(`/sessions/${back.sessionId}/schedule`);
    // Practice alone: 2 matches at 09:00 and 09:02:30, open-ended. The
    // game's matches are 2 minutes, so the second finishes at 09:04:30.
    await page.getByRole("button", { name: "Remove phase" }).nth(1).click();
    await page.getByLabel("Fixed cycle time").check();
    await page.getByLabel("Cycle time minutes").fill("2");
    await page.getByLabel("Cycle time seconds").fill("30");
    await page.getByLabel("End time for block 1").fill("");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Clear Practice" })).toBeVisible();

    // The form remounts offering only Qualification.
    await page.getByLabel("Matches per team for phase 1").fill("1");
    await page.getByLabel("Fixed cycle time").check();
    await page.getByLabel("Cycle time minutes").fill("2");
    await page.getByLabel("Cycle time seconds").fill("30");
    await page.getByLabel("Start time for block 1").fill("09:04");
    await page.getByLabel("End time for block 1").fill("");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "overlapping the practice round's matches on 2026-11-07, which run from 09:00 to 09:04:30 " +
        "(America/Los_Angeles). Start the new block at 09:05 or later."
    );

    await page.getByLabel("Start time for block 1").fill("09:05");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();
  });

  test("clearing one round of a two-phase generate frees its time for a new one", async ({ page, request }) => {
    const phased = await createReadySession(request, "Two Phase E2E", "TPH");
    const set = await (
      await request.post("/api/field-sets", {
        headers: headers(),
        data: { session_id: phased.sessionId, name: "TPH Fields", division_id: null },
      })
    ).json();
    await request.post("/api/fields", {
      headers: headers(),
      data: { session_id: phased.sessionId, name: "TPH Field 1", field_set_id: set.id },
    });

    await loginAsAdmin(page);
    await page.goto(`/sessions/${phased.sessionId}/schedule`);
    // The default phases, Practice x1 then Qualification x6, in one
    // open-ended block: practice's 2 matches run 09:00-09:04:30.
    await page.getByLabel("Fixed cycle time").check();
    await page.getByLabel("Cycle time minutes").fill("2");
    await page.getByLabel("Cycle time seconds").fill("30");
    await page.getByLabel("End time for block 1").fill("");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();

    await page.getByRole("button", { name: "Clear Qualification" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toHaveCount(0);

    await page.getByLabel("Fixed cycle time").check();
    await page.getByLabel("Cycle time minutes").fill("2");
    await page.getByLabel("Cycle time seconds").fill("30");
    await page.getByLabel("Start time for block 1").fill("09:05");
    await page.getByLabel("End time for block 1").fill("");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();
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

    try {
      await loginAsAdmin(page);
      await page.goto(`/sessions/${sessionId}/schedule`);
      await expect(page.getByLabel("Division").locator(`option[value="${second.id}"]`)).toHaveText(
        "E2E Blue (8 teams checked in)"
      );
      await page.getByLabel("Division").selectOption(String(first.id));
      await page.getByRole("button", { name: "Generate" }).click();
      await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();

      await page.getByLabel("Division").selectOption(String(second.id));
      await expect(page.getByText("No rounds have been generated yet.")).toBeVisible();
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
