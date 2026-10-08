import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "skills-e2e-pw";

test.describe.serial("skills challenges", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let sunday = 0;
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

  async function post(request: APIRequestContext, route: string, data: unknown) {
    const response = await request.post(api(route), { headers: headers(), data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  async function recordViaApi(request: APIRequestContext, session: number, team: string, skillsType: string, score: number) {
    await post(request, `/api/sessions/${session}/skills/attempts`, {
      team_id: teams[team],
      skills_type: skillsType,
      data: { score },
    });
  }

  const recordRegion = (page: Page) => page.getByRole("region", { name: "Record an attempt" });
  const attemptsTable = (page: Page) => page.getByRole("table", { name: "Attempts", exact: true });

  async function pick(page: Page, number: string, typeLabel: string) {
    const region = recordRegion(page);
    const change = region.getByRole("button", { name: "Change team" });
    if (await change.isVisible()) await change.click();
    await region.getByRole("combobox", { name: "Team" }).fill(number);
    await region.getByRole("option", { name: new RegExp(`^${number} `) }).click();
    await region.getByRole("button", { name: typeLabel, exact: true }).click();
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8128, frontendPort: 5188 });
    expect((await request.post(api("/api/event"), { data: { name: "Skills League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    for (const [number, name] of [["S1", "Skills One"], ["S2", "Skills Two"], ["S3", "Skills Three"], ["S4", "Skills Four"]]) {
      teams[number] = (await post(request, "/api/teams", { number, name })).id;
    }
    saturday = (await post(request, "/api/sessions", { label: "Skills Saturday", session_date: "2026-10-10" })).id;
    sunday = (await post(request, "/api/sessions", { label: "Skills Sunday", session_date: "2026-10-11" })).id;
    for (const number of ["S1", "S2", "S3"]) {
      await post(request, `/api/sessions/${saturday}/participants`, { team_id: teams[number], checked_in: true });
    }
    await post(request, `/api/sessions/${sunday}/participants`, { team_id: teams.S1, checked_in: true });
  });

  test.afterAll(() => server?.stop());

  test("Event Setup enables the skills panel once a game is chosen, and skills turn on", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    await expect(page.getByText("Choose a game plugin above before setting up skills challenges.")).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Run skills challenges" });
    await expect(toggle).toBeDisabled();

    await page.getByRole("button", { name: "Select for this event" }).click();
    await expect(toggle).toBeEnabled();
    await expect(page.getByLabel("Autonomous attempts")).toHaveValue("3");
    await expect(page.getByLabel("Driver attempts")).toHaveValue("3");
    await toggle.check();
    await page.getByRole("button", { name: "Save skills settings" }).click();
    await expect(page.getByText("Skills settings saved.")).toBeVisible();
  });

  test("a team not checked in is not offered, and attempts are recorded for two types", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/matches`);
    await page.getByRole("link", { name: "Skills", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${saturday}/skills$`));
    await expect(page.getByText("Autonomous 3 · Driver 3 (event setting)")).toBeVisible();

    const region = recordRegion(page);
    await region.getByRole("combobox", { name: "Team" }).fill("S4");
    await expect(region.getByRole("option")).toHaveCount(0);
    await expect(region.getByText("No checked-in team matches.")).toBeVisible();

    await region.getByRole("combobox", { name: "Team" }).fill("S1");
    await region.getByRole("option", { name: "S1 Skills One" }).click();
    await region.getByRole("button", { name: "Autonomous", exact: true }).click();
    await expect(region.getByText("Attempt 1 of 3")).toBeVisible();
    await region.getByLabel("Score", { exact: true }).fill("20");
    await region.getByRole("button", { name: "Save attempt" }).click();
    await expect(region.getByText("Saved: 20 points")).toBeVisible();
    await expect(region.getByText("Attempt 2 of 3")).toBeVisible();

    await region.getByRole("button", { name: "Driver", exact: true }).click();
    await region.getByLabel("Score", { exact: true }).fill("34");
    await region.getByRole("button", { name: "Save attempt" }).click();
    await expect(region.getByText("Saved: 34 points")).toBeVisible();

    await recordViaApi(request, saturday, "S2", "autonomous", 28);
    await recordViaApi(request, saturday, "S2", "driver", 30);
    await recordViaApi(request, saturday, "S3", "driver", 34);
    // Recorded elsewhere: the table follows over the realtime channel.
    await expect(attemptsTable(page).locator("tbody tr")).toHaveCount(3);
  });

  test("Session Rankings rank the Overall and per-type tabs", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/rankings`);
    await expect(page.getByRole("tab", { name: "Teamwork", exact: true })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "Overall Skills", exact: true }).click();
    await expect(page.getByText("Ties go to the higher Autonomous best, then Driver best", { exact: false })).toBeVisible();
    const overall = page.getByRole("table", { name: "Overall Skills" }).locator("tbody tr");
    await expect(overall).toHaveCount(3);
    await expect(overall.nth(0)).toContainText("S2");
    await expect(overall.nth(0)).toContainText("58");
    await expect(overall.nth(1)).toContainText("S1");
    await expect(overall.nth(1)).toContainText("54");
    await expect(overall.nth(2)).toContainText("S3");

    await page.getByRole("tab", { name: "Driver", exact: true }).click();
    const driver = page.getByRole("table", { name: "Driver" }).locator("tbody tr");
    await expect(driver.locator("td:first-child")).toHaveText(["1", "1", "3"]);
    await expect(driver.nth(0)).toContainText("S1");
    await expect(driver.nth(1)).toContainText("S3");
    await expect(driver.nth(2)).toContainText("S2");
  });

  test("the attempts table filters by team, and editing an attempt changes the rankings", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    const rows = attemptsTable(page).locator("tbody tr");
    await expect(rows).toHaveCount(3);
    const find = page.getByLabel("Find team");
    await find.fill("s1");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("S1");
    await find.fill("zz");
    await expect(page.getByText("No teams match 'zz'")).toBeVisible();
    await find.fill("");
    await expect(rows).toHaveCount(3);

    await attemptsTable(page).getByRole("button", { name: "Edit Autonomous attempt 1 for team S2: 28 points" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Autonomous attempt 1 · Team S2" });
    await expect(dialog.getByLabel("Score", { exact: true })).toHaveValue("28");
    await dialog.getByLabel("Score", { exact: true }).fill("18");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      attemptsTable(page).getByRole("button", { name: "Edit Autonomous attempt 1 for team S2: 18 points" })
    ).toBeVisible();

    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await page.getByRole("tab", { name: "Overall Skills", exact: true }).click();
    const overall = page.getByRole("table", { name: "Overall Skills" }).locator("tbody tr");
    await expect(overall.nth(0)).toContainText("S1");
    await expect(overall.nth(0)).toContainText("54");
    await expect(overall.nth(1)).toContainText("S2");
    await expect(overall.nth(1)).toContainText("48");
  });

  test("a session override limits attempts until the event setting is restored", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await page.getByRole("button", { name: "Change for this session" }).click();
    await page.getByLabel("Driver attempts").fill("1");
    await page.getByRole("button", { name: "Save for this session" }).click();
    await expect(page.getByText("Autonomous 3 · Driver 1 (this session)")).toBeVisible();

    await pick(page, "S1", "Driver");
    const region = recordRegion(page);
    await expect(region.getByText("Team S1 has used all 1 Driver attempts.")).toBeVisible();
    await expect(region.getByRole("button", { name: "Save attempt" })).toBeDisabled();

    await page.getByRole("button", { name: "Use event setting" }).click();
    await expect(page.getByText("Autonomous 3 · Driver 3 (event setting)")).toBeVisible();
    await expect(region.getByText("Attempt 2 of 3")).toBeVisible();
    await expect(region.getByRole("button", { name: "Save attempt" })).toBeEnabled();
  });

  test("an out-of-range score is reported beside the field and nothing is saved", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await pick(page, "S2", "Autonomous");
    const region = recordRegion(page);
    const score = region.getByLabel("Score", { exact: true });
    await score.fill("1000");
    await region.getByRole("button", { name: "Save attempt" }).click();
    await expect(region.getByText("Must be at most 999.")).toBeVisible();
    await expect(score).toHaveAttribute("aria-invalid", "true");
    await expect(attemptsTable(page).getByRole("button", { name: /for team S2:/ })).toHaveCount(2);
  });

  test("deleting an attempt gives it back", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await attemptsTable(page).getByRole("button", { name: "Edit Driver attempt 1 for team S2: 30 points" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete attempt" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete this attempt?" });
    await expect(confirm.getByText("Team S2 gets this Driver attempt back.")).toBeVisible();
    await confirm.getByRole("button", { name: "Delete attempt" }).click();
    await expect(confirm).toBeHidden();
    await expect(attemptsTable(page).getByRole("button", { name: /^Edit Driver attempt .* team S2:/ })).toHaveCount(0);

    await pick(page, "S2", "Driver");
    await expect(recordRegion(page).getByText("Attempt 1 of 3")).toBeVisible();
  });

  test("Season Rankings show the best session's score, not a mix of sessions", async ({ page, request }) => {
    // Sunday: S1 24 + 28 = 52. Saturday stays 20 + 34 = 54. Mixing bests would give 24 + 34 = 58.
    await recordViaApi(request, sunday, "S1", "autonomous", 24);
    await recordViaApi(request, sunday, "S1", "driver", 28);
    await login(page);
    await page.goto(`${server.baseUrl}/rankings`);
    await page.getByRole("tab", { name: "Overall Skills", exact: true }).click();
    await expect(page.getByText("Season scores come from the team's best session.", { exact: false })).toBeVisible();
    const row = page.getByRole("table", { name: "Overall Skills" }).locator("tbody tr").filter({ hasText: "S1" });
    await expect(row).toContainText("54");
    await expect(row).toContainText("20 · 34");
    await expect(row).toContainText("Skills Saturday");
  });

  test("turning skills off hides the Skills page and tabs", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    const toggle = page.getByRole("switch", { name: "Run skills challenges" });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.getByRole("button", { name: "Save skills settings" }).click();
    await expect(page.getByText("Skills settings saved.")).toBeVisible();

    // Absence checks only mean something once the skills settings have loaded.
    const settingsLoaded = page.waitForResponse(
      (response) => response.url().endsWith("/api/skills/settings") && response.request().method() === "GET" && response.ok()
    );
    await page.goto(`${server.baseUrl}/sessions/${saturday}/rankings`);
    await settingsLoaded;
    await expect(page.getByRole("tab", { name: "Teamwork", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Rankings", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overall Skills", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Skills", exact: true })).toHaveCount(0);

    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await expect(page.getByText("Skills challenges are turned off for this event.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Event Setup" })).toHaveAttribute("href", "/events/setup");
  });
});
