import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "awards-e2e-pw";

test.describe.serial("awards", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let sunday = 0;
  const teams: Record<string, number> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page, role = "admin") {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill(role);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }

  async function post(request: APIRequestContext, route: string, data: unknown) {
    const response = await request.post(api(route), { headers: headers(), data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  const card = (page: Page, name: string) => page.getByRole("article", { name });

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8129, frontendPort: 5189 });
    expect((await request.post(api("/api/event"), { data: { name: "Awards League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    // Select the uploaded plugin for the event the same way skillsChallenges.spec.ts's UI step does, but via the API:
    await post(request, "/api/event/game-plugin", { name: (await uploaded.json()).name });
    for (const [number, name] of [["T1", "Team One"], ["T2", "Team Two"], ["T3", "Team Three"], ["T4", "Team Four"]]) {
      teams[number] = (await post(request, "/api/teams", { number, name })).id;
    }
    saturday = (await post(request, "/api/sessions", { label: "Awards Saturday", session_date: "2026-10-10" })).id;
    sunday = (await post(request, "/api/sessions", { label: "Awards Sunday", session_date: "2026-10-11" })).id;
    for (const number of ["T1", "T2", "T3", "T4"]) {
      await post(request, `/api/sessions/${saturday}/participants`, { team_id: teams[number], checked_in: true });
    }
    await post(request, "/api/event/active-session", { session_id: saturday });
    const skills = await request.put(api("/api/skills/settings"), { headers: headers(), data: { enabled: true, attempts: {} } });
    expect(skills.ok(), await skills.text()).toBeTruthy();
    for (const [number, score] of [["T2", 30], ["T1", 20], ["T3", 10]] as const) {
      await post(request, `/api/sessions/${saturday}/skills/attempts`, {
        team_id: teams[number], skills_type: "driver", data: { score },
      });
    }
  });

  test.afterAll(() => server?.stop());

  test("admin defines awards and sees the live skills winner", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    await expect(page.getByText("No awards yet. Add one, or copy them from another session.")).toBeVisible();

    await page.getByRole("button", { name: "Add award" }).click();
    let dialog = page.getByRole("alertdialog", { name: "Add award" });
    await dialog.getByLabel("Award name").fill("Driver Skills Champion");
    await dialog.getByLabel("Performance").check();
    await dialog.getByLabel("Event-wide (one winner)").check();
    await dialog.getByLabel("Winner comes from").selectOption({ label: "Skills type" });
    await dialog.getByRole("combobox", { name: "Skills type", exact: true }).selectOption({ label: "Driver" });
    await dialog.getByRole("button", { name: "Save award" }).click();
    await expect(card(page, "Driver Skills Champion").getByText("T2 Team Two")).toBeVisible();
    await expect(card(page, "Driver Skills Champion").getByText("Live")).toBeVisible();

    await page.getByRole("button", { name: "Add award" }).click();
    dialog = page.getByRole("alertdialog", { name: "Add award" });
    await dialog.getByLabel("Award name").fill("Excellence Award");
    await dialog.getByLabel("Description (optional)").fill("The top all-round team");
    await dialog.getByLabel("Event-wide (one winner)").check();
    await dialog.getByRole("button", { name: "Save award" }).click();
    await expect(card(page, "Excellence Award").getByText("Pending")).toBeVisible();
  });

  test("a new skills score moves the live winner", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    await expect(card(page, "Driver Skills Champion").getByText("T2 Team Two")).toBeVisible();
    await post(request, `/api/sessions/${saturday}/skills/attempts`, {
      team_id: teams.T4, skills_type: "driver", data: { score: 50 },
    });
    await expect(card(page, "Driver Skills Champion").getByText("T4 Team Four")).toBeVisible();
  });

  test("admin overrides the skills winner with a reason", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    await card(page, "Driver Skills Champion").getByRole("button", { name: /^Override/ }).click();
    const dialog = page.getByRole("alertdialog", { name: "Override Driver Skills Champion" });
    await dialog.getByRole("checkbox", { name: /T1 Team One/ }).check();
    await dialog.getByLabel("Reason for the override").fill("T4 missed inspection");
    await dialog.getByRole("button", { name: "Save" }).click();
    const champion = card(page, "Driver Skills Champion");
    await expect(champion.getByText("Overridden")).toBeVisible();
    await expect(champion.getByText("Override reason: T4 missed inspection")).toBeVisible();
  });

  test("a judge sees only the judge pages and chooses the judged winner", async ({ page }) => {
    await login(page, "judge");
    await expect(page).toHaveURL(`${server.baseUrl}/judge/awards`);
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link")).toHaveText(["Awards", "Session rankings", "Season rankings"]);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByText("Driver Skills Champion")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add award" })).toHaveCount(0);

    await card(page, "Excellence Award").getByRole("button", { name: /^Choose winner/ }).click();
    const dialog = page.getByRole("alertdialog", { name: "Choose the winner of Excellence Award" });
    await dialog.getByLabel("Find a team").fill("T3");
    const searchBox = await dialog.getByLabel("Find a team").boundingBox();
    const teamList = await dialog.getByRole("radiogroup", { name: "Teams" }).boundingBox();
    expect(teamList!.y - (searchBox!.y + searchBox!.height)).toBeGreaterThanOrEqual(12);
    await dialog.getByRole("radio", { name: /T3 Team Three/ }).check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(card(page, "Excellence Award").getByText("T3 Team Three")).toBeVisible();

    await page.goto(`${server.baseUrl}/teams`);
    await expect(page).toHaveURL(`${server.baseUrl}/judge/awards`);
    await page.getByRole("link", { name: "Session rankings" }).click();
    await expect(page).toHaveURL(`${server.baseUrl}/judge/rankings`);
  });

  test("admin finalizes, sees the lock, and unfinalizes", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    await page.getByRole("button", { name: "Finalize awards" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Finalize awards?" });
    await expect(dialog.getByText("Every award has a winner.")).toBeVisible();
    await dialog.getByRole("button", { name: "Finalize awards" }).click();
    await expect(page.getByText(/Awards finalized on/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add award" })).toBeDisabled();
    await page.getByRole("button", { name: "Unfinalize" }).click();
    await expect(page.getByRole("button", { name: "Add award" })).toBeEnabled();
  });

  test("the CSV downloads with the winners", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export CSV" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`awards-${saturday}.csv`);
    const text = fs.readFileSync(await download.path(), "utf8");
    expect(text.split("\n")[0]).toBe("award,description,division,placement,team_number,team_name,organization,status");
    expect(text).toContain("Excellence Award,The top all-round team,,,T3,Team Three,,judged");
  });

  test("admin copies awards to another session", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${sunday}/awards`);
    await page.getByRole("button", { name: "Copy awards from…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Copy awards" });
    await dialog.getByLabel("Copy from session").selectOption({ label: "Awards Saturday" });
    await dialog.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(card(page, "Excellence Award").getByText("Pending")).toBeVisible();
  });

  test("a per-division teamwork award resolves in a single-division event", async ({ page, request }) => {
    // Scheduled with no division id, as the admin UI does in a single-division event.
    const match = await post(request, "/api/matches", {
      session_id: sunday,
      round_type: "qualification",
      match_number: 1,
      field_id: null,
      alliances: [
        { station: "red", team_ids: [teams.T1] },
        { station: "blue", team_ids: [teams.T2] },
      ],
    });
    const red = match.alliances.find((a: { station: string }) => a.station === "red");
    await post(request, `/api/matches/${match.id}/alliances/${red.id}/score`, { data: { score: 40 } });

    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${sunday}/awards`);
    await page.getByRole("button", { name: "Add award" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Add award" });
    await dialog.getByLabel("Award name").fill("Teamwork Champion");
    await dialog.getByLabel("Performance").check();
    await dialog.getByLabel("Per division").check();
    await dialog.getByLabel("Winner comes from").selectOption({ label: "Teamwork ranking" });
    await dialog.getByRole("button", { name: "Save award" }).click();
    const champion = card(page, "Teamwork Champion");
    await expect(champion.getByText("Live")).toBeVisible();
    await expect(champion.getByText(/T[12] Team (One|Two)/).first()).toBeVisible();
  });
});
