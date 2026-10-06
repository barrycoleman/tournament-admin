import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildCooperativeGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

// The shared E2E event is locked to the head-to-head example game, so the
// cooperative flows run against their own backend and Vite server.
const PASSWORD = "coop-e2e-pw";

test.describe.serial("cooperative rankings and ranking settings", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let sessionOne = 0;
  let sessionTwo = 0;
  const teams: Record<string, number> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${server.baseUrl}/`);
  }

  async function playMatch(request: APIRequestContext, sessionId: number, number: number, objects: number) {
    const created = await request.post(api("/api/matches"), {
      headers: headers(),
      data: {
        session_id: sessionId,
        round_type: "qualification",
        match_number: number,
        field_id: null,
        alliances: [
          { station: "red", team_ids: [teams.C1] },
          { station: "blue", team_ids: [teams.C2] },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    const match = await created.json();
    const red = match.alliances.find((a: { station: string }) => a.station === "red");
    const scored = await request.post(api(`/api/matches/${match.id}/alliances/${red.id}/score`), {
      headers: headers(),
      data: { data: { objects_scored: objects } },
    });
    expect(scored.ok()).toBeTruthy();
  }

  function cell(page: Page, teamNumber: string, column: number) {
    return page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: teamNumber, exact: true }) })
      .getByRole("cell")
      .nth(column);
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8125, frontendPort: 5185 });
    const created = await request.post(api("/api/event"), {
      data: { name: "Cooperative League", password: PASSWORD },
    });
    expect(created.status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    for (const number of ["C1", "C2"]) {
      const team = await request.post(api("/api/teams"), { headers: headers(), data: { number, name: `Crew ${number}` } });
      teams[number] = (await team.json()).id;
    }
    for (const label of ["Saturday", "Sunday"]) {
      const session = await request.post(api("/api/sessions"), { headers: headers(), data: { label } });
      if (label === "Saturday") sessionOne = (await session.json()).id;
      else sessionTwo = (await session.json()).id;
    }
  });

  test.afterAll(() => server?.stop());

  test("selecting the cooperative game reveals the ranking settings", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    await expect(page.getByRole("heading", { name: "Game plugins" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranking settings" })).toHaveCount(0);

    await page.getByLabel("Install a plugin (.zip)").first().setInputFiles(await buildCooperativeGamePluginZip());
    await expect(page.getByText("Cooperative Scoring Game")).toBeVisible();
    await page.getByRole("button", { name: "Select for this event" }).click();

    await expect(page.getByRole("heading", { name: "Ranking settings" })).toBeVisible();
  });

  test("session and season rankings for a two-session league", async ({ page, request }) => {
    await playMatch(request, sessionOne, 1, 10); // 20
    await playMatch(request, sessionOne, 2, 5); // 10
    await playMatch(request, sessionTwo, 1, 15); // 30

    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${sessionOne}/rankings`);
    await expect(cell(page, "C1", 3)).toHaveText("15.00");
    await expect(cell(page, "C1", 4)).toHaveText("2");

    await page.getByRole("link", { name: "Season rankings" }).click();
    await expect(page.getByRole("tab", { name: "Teamwork" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Average of every qualification match.")).toBeVisible();
    await expect(cell(page, "C1", 3)).toHaveText("20.00");
    await expect(cell(page, "C1", 4)).toHaveText("3");
  });

  test("saving season settings recalculates the season, live", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    const season = page.getByRole("group", { name: "Season rankings" });
    await season.getByLabel("Keep best matches").fill("2");
    await season.getByLabel("Minimum matches").fill("2");
    await page.getByRole("button", { name: "Save ranking settings" }).click();
    await expect(page.getByText("Settings saved. Rankings recalculated.")).toBeVisible();

    const socket = page.waitForEvent("websocket", (ws) => ws.url().includes("/ws/active-session"));
    await page.getByRole("link", { name: "Season rankings" }).click();
    await socket;
    await expect(page.getByText("Best 2 matches · minimum 2")).toBeVisible();
    await expect(cell(page, "C1", 3)).toHaveText("25.00");

    const saved = await request.put(api("/api/ranking-settings"), {
      headers: headers(),
      data: {
        session_drop_mode: "tiered",
        session_drop_count: 1,
        session_drop_no_show: false,
        session_drop_dq: false,
        season_keep_best: 4,
        season_only_session_counted: false,
        season_minimum: 4,
        season_drop_no_show: false,
        season_drop_dq: false,
      },
    });
    expect(saved.ok()).toBeTruthy();
    await expect(cell(page, "C1", 3)).toHaveText("15.00"); // (20 + 10 + 30) / 4, without a reload
  });

  test("a minimum above the kept matches is refused", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    const season = page.getByRole("group", { name: "Season rankings" });
    await season.getByLabel("Keep best matches").fill("2");
    await season.getByLabel("Minimum matches").fill("3");
    await page.getByRole("button", { name: "Save ranking settings" }).click();
    await expect(page.getByText("Minimum can't be more than the number of matches kept.")).toBeVisible();

    const current = await (await request.get(api("/api/ranking-settings"), { headers: headers() })).json();
    expect(current.season_keep_best).toBe(4);
  });
});
