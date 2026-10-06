import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

// "zz_" runs this after every other spec: it adds teams to the shared event
// (the team-grid specs assume a small roster) and must not disturb
// z_sessionSchedule's division setup. Assertions are scoped to this file's
// own teams, since earlier specs leave scored matches of their own.
let token = "";
const headers = () => ({ Authorization: `Bearer ${token}` });
const teams: Record<string, number> = {};
let sessionOne = 0;
let sessionTwo = 0;

async function playMatch(
  request: APIRequestContext,
  sessionId: number,
  matchNumber: number,
  red: string,
  blue: string,
  redHigh: number,
  blueHigh: number,
  roundType = "qualification"
) {
  const created = await request.post("/api/matches", {
    headers: headers(),
    data: {
      session_id: sessionId,
      round_type: roundType,
      match_number: matchNumber,
      field_id: null,
      alliances: [
        { station: "red", team_ids: [teams[red]] },
        { station: "blue", team_ids: [teams[blue]] },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();
  const match = await created.json();
  for (const alliance of match.alliances) {
    const high = alliance.station === "red" ? redHigh : blueHigh;
    const scored = await request.post(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
      headers: headers(),
      data: { data: { high_balls: high, low_balls: 0, auto_winner: "tie" } },
    });
    expect(scored.ok()).toBeTruthy();
  }
}

function cell(page: Page, teamNumber: string, column: number) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: teamNumber, exact: true }) })
    .getByRole("cell")
    .nth(column);
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
}

test.describe.serial("head-to-head session and season rankings", () => {
  test.beforeAll(async ({ request }) => {
    const created = await request.post("/api/event", { data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD } });
    expect([201, 409]).toContain(created.status());
    token = (await (await request.post("/api/auth/login", { data: { role: "admin", password: E2E_EVENT_PASSWORD } })).json())
      .access_token;
    const event = await (await request.get("/api/event")).json();
    if (event.game_plugin_name === null) {
      const uploaded = await request.post("/api/plugins/games", {
        headers: headers(),
        multipart: {
          file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildExampleGamePluginZip()) },
        },
      });
      expect([201, 409]).toContain(uploaded.status());
      expect((await request.post("/api/event/game-plugin", { headers: headers(), data: { name: "example-game" } })).ok()).toBeTruthy();
    }
    for (const number of ["RK1", "RK2", "RK3"]) {
      const team = await request.post("/api/teams", { headers: headers(), data: { number, name: `Ranker ${number}` } });
      expect(team.ok()).toBeTruthy();
      teams[number] = (await team.json()).id;
    }
    sessionOne = (await (await request.post("/api/sessions", { headers: headers(), data: { label: "Rankings Saturday" } })).json()).id;
    sessionTwo = (await (await request.post("/api/sessions", { headers: headers(), data: { label: "Rankings Sunday" } })).json()).id;

    await playMatch(request, sessionOne, 1, "RK1", "RK2", 16, 6); // RK1 wins
    await playMatch(request, sessionTwo, 1, "RK1", "RK2", 10, 10); // tie
    await playMatch(request, sessionTwo, 2, "RK3", "RK2", 16, 6); // RK3 wins; RK3 missed Saturday
    await playMatch(request, sessionTwo, 3, "RK2", "RK1", 20, 0, "practice"); // never counts
  });

  test("a session's Rankings tab shows that session's win points", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${sessionOne}/matches`);
    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await expect(cell(page, "RK1", 3)).toHaveText("2");
    await expect(cell(page, "RK2", 3)).toHaveText("0");
    await expect(page.getByRole("cell", { name: "RK3", exact: true })).toHaveCount(0);
  });

  test("season rankings total every session's qualification matches", async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole("link", { name: "Season rankings" }).click();
    await expect(cell(page, "RK1", 3)).toHaveText("3");
    await expect(cell(page, "RK3", 3)).toHaveText("2");
    await expect(cell(page, "RK2", 3)).toHaveText("1");
    const rank = async (team: string) => Number(await cell(page, team, 0).textContent());
    expect(await rank("RK1")).toBeLessThan(await rank("RK3"));
    expect(await rank("RK3")).toBeLessThan(await rank("RK2"));
  });

  test("season rankings update live when a match is scored", async ({ page, request }) => {
    await loginAsAdmin(page);
    const socket = page.waitForEvent("websocket", (ws) => ws.url().includes("/ws/active-session"));
    await page.goto("/rankings");
    await socket;
    await expect(cell(page, "RK2", 3)).toHaveText("1");

    await playMatch(request, sessionTwo, 4, "RK2", "RK3", 16, 6);
    await expect(cell(page, "RK2", 3)).toHaveText("3");
  });

  test("head-to-head events have no ranking settings panel", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/events/setup");
    await expect(page.getByRole("heading", { name: "Game plugins" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranking settings" })).toHaveCount(0);
  });
});
