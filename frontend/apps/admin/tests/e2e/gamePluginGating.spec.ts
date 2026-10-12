import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildExampleGamePluginZip, buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "gating-e2e-pw";

test.describe.serial("game plugin gating", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let sampleName = "";
  let exampleDisplayName = "";
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

  async function upload(request: APIRequestContext, zipPath: string) {
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(zipPath) },
      },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    return (await uploaded.json()) as { name: string; display_name: string };
  }

  const noPlugin = (page: Page) => page.getByText(/This needs a game plugin\./);
  const banner = (page: Page) => page.getByText(/Choose a game plugin to set up/);

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8130, frontendPort: 5190 });
    expect((await request.post(api("/api/event"), { data: { name: "Gating League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    const example = await upload(request, await buildExampleGamePluginZip());
    exampleDisplayName = example.display_name;
    sampleName = (await upload(request, await buildSampleCooperativePluginZip())).name;
    for (const [number, name] of [["T1", "Team One"], ["T2", "Team Two"], ["T3", "Team Three"], ["T4", "Team Four"]]) {
      teams[number] = (await post(request, "/api/teams", { number, name })).id;
    }
    saturday = (await post(request, "/api/sessions", { label: "Gating Saturday", session_date: "2026-10-10" })).id;
    await post(request, "/api/event/active-session", { session_id: saturday });
  });

  test.afterAll(() => server?.stop());

  test("with no plugin, admins see the banner and locked screens", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/teams`);
    await expect(page.getByText("Choose a game plugin to set up scheduling, matches, rankings and skills.")).toBeVisible();
    await page.goto(`${server.baseUrl}/sessions/${saturday}/matches`);
    await expect(noPlugin(page)).toBeVisible();
    await page.goto(`${server.baseUrl}/sessions/${saturday}/rankings`);
    await expect(noPlugin(page)).toBeVisible();
    await page.goto(`${server.baseUrl}/rankings`);
    await expect(noPlugin(page)).toBeVisible();
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    await page.getByRole("button", { name: "Add award" }).click();
    await expect(page.getByRole("radio", { name: "Performance" })).toBeDisabled();
    await expect(page.getByText("Needs a game plugin.")).toBeVisible();
  });

  test("judges see the no-link panel and no banner", async ({ page }) => {
    await login(page, "judge");
    await page.goto(`${server.baseUrl}/judge/rankings`);
    await expect(page.getByText("The organizer hasn't chosen a game plugin yet.")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("choosing a plugin unlocks every open page live", async ({ browser }) => {
    const other = await browser.newPage();
    await login(other);
    await other.goto(`${server.baseUrl}/sessions/${saturday}/matches`);
    await expect(noPlugin(other)).toBeVisible();

    const page = await browser.newPage();
    await login(page);
    await page.getByRole("link", { name: "Choose a game plugin" }).click();
    await expect(page).toHaveURL(/\/events\/setup#game-plugins/);
    await page
      .getByRole("listitem")
      .filter({ hasText: exampleDisplayName })
      .getByRole("button", { name: "Select for this event" })
      .click();
    await expect(page.getByRole("button", { name: "Clear selection" })).toBeVisible();

    await expect(noPlugin(other)).toHaveCount(0);
    await expect(banner(other)).toHaveCount(0);
    await other.close();
    await page.close();
  });

  test("switching while unused confirms what resets, then turns skills off", async ({ page, request }) => {
    // The sample cooperative game has skills types: select it, turn skills on, then switch away.
    await post(request, "/api/event/game-plugin", { name: sampleName });
    const skills = await request.put(api("/api/skills/settings"), { headers: headers(), data: { enabled: true, attempts: {} } });
    expect(skills.ok(), await skills.text()).toBeTruthy();
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    await page.getByRole("listitem").filter({ hasText: exampleDisplayName }).getByRole("button", { name: "Switch to this" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Skills challenges will be turned off.");
    await dialog.getByRole("button", { name: "Switch plugin" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Run skills challenges" })).not.toBeChecked();
  });

  test("award sources follow the skills switch", async ({ page, request }) => {
    await post(request, "/api/event/game-plugin", { name: sampleName });
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
    await page.getByRole("button", { name: "Add award" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("radio", { name: "Performance" }).check();
    const source = dialog.getByRole("combobox", { name: "Winner comes from" });
    await expect(source.locator("option")).toHaveText(["Teamwork ranking", "Finals placement"]);
    await dialog.getByRole("radio", { name: "Event-wide (one winner)" }).check();
    await expect(dialog.getByText("Event-wide performance awards come from skills challenges, which are off.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const skills = await request.put(api("/api/skills/settings"), { headers: headers(), data: { enabled: true, attempts: {} } });
    expect(skills.ok(), await skills.text()).toBeTruthy();
    await page.reload();
    await page.getByRole("button", { name: "Add award" }).click();
    await page.getByRole("alertdialog").getByRole("radio", { name: "Performance" }).check();
    await expect(
      page.getByRole("alertdialog").getByRole("combobox", { name: "Winner comes from" }).locator("option")
    ).toHaveText(["Teamwork ranking", "Finals placement", "Overall skills", "Skills type"]);
  });

  test("a scheduled match locks the plugin", async ({ page, request }) => {
    await post(request, "/api/matches", {
      session_id: saturday, round_type: "qualification", match_number: 1, field_id: null,
      alliances: [
        { station: "red", team_ids: [teams.T1] },
        { station: "blue", team_ids: [teams.T2] },
      ],
    });
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    await expect(page.getByText("Locked because matches are scheduled or skills attempts are recorded.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch to this" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear selection" })).toHaveCount(0);
  });
});
