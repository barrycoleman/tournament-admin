import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildCooperativeGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "finalize-e2e-pw";

test.describe.serial("finalizing cooperative qualification", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let session = 0;
  const teams: Record<string, number> = {};
  const unplayed: number[] = [];
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${server.baseUrl}/`);
  }

  async function createMatch(request: APIRequestContext, number: number, red: string, blue: string) {
    const created = await request.post(api("/api/matches"), {
      headers: headers(),
      data: {
        session_id: session,
        round_type: "qualification",
        match_number: number,
        field_id: null,
        alliances: [
          { station: "red", team_ids: [teams[red]] },
          { station: "blue", team_ids: [teams[blue]] },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    return created.json();
  }

  async function score(request: APIRequestContext, match: { id: number; alliances: { id: number; station: string }[] }, objects: number) {
    const red = match.alliances.find((a) => a.station === "red")!;
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
    server = await startIsolatedServer({ backendPort: 8127, frontendPort: 5187 });
    expect((await request.post(api("/api/event"), { data: { name: "Finalize League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildCooperativeGamePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    expect((await request.post(api("/api/event/game-plugin"), { headers: headers(), data: { name: "cooperative-game" } })).ok()).toBeTruthy();
    for (const number of ["F1", "F2", "F3", "F4"]) {
      teams[number] = (await (await request.post(api("/api/teams"), { headers: headers(), data: { number, name: `Finisher ${number}` } })).json()).id;
    }
    session = (await (await request.post(api("/api/sessions"), { headers: headers(), data: { label: "Short Saturday" } })).json()).id;
    await request.post(api("/api/fields"), { headers: headers(), data: { session_id: session, name: "Field 1" } });
    // F1+F2: 5 scheduled, 4 played (scores 10, 20, 30, 40). F3+F4: 5 scheduled, 5 played (10..50).
    for (let n = 1; n <= 5; n += 1) {
      const match = await createMatch(request, n, "F1", "F2");
      if (n <= 4) await score(request, match, n * 5);
      else unplayed.push(match.id);
    }
    for (let n = 6; n <= 10; n += 1) {
      await score(request, await createMatch(request, n, "F3", "F4"), (n - 5) * 5);
    }
  });

  test.afterAll(() => server?.stop());

  test("finalize is blocked while a match is in progress", async ({ page, request }) => {
    expect((await request.post(api(`/api/matches/${unplayed[0]}/start`), { headers: headers() })).ok()).toBeTruthy();
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    const finalize = page.getByRole("button", { name: "Finalize qualification" });
    await expect(page.getByText("1 match is in progress.")).toBeVisible();
    await expect(finalize).toBeDisabled();

    expect((await request.post(api(`/api/matches/${unplayed[0]}/reset`), { headers: headers(), data: { scope: "full" } })).ok()).toBeTruthy();
    await expect(finalize).toBeEnabled();
  });

  test("finalize with adjusted drops, then rankings and Not played reflect it", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    await page.getByRole("button", { name: "Finalize qualification" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Finalize qualification" });
    const four = dialog.getByLabel("4 played (2 teams)");
    const five = dialog.getByLabel("5 played (2 teams)");
    await expect(four).toHaveValue("1");
    await expect(five).toHaveValue("1");
    await expect(dialog.getByText("1 unplayed match will be marked Not played.")).toBeVisible();

    await four.fill("4");
    await expect(dialog.getByText("Enter a whole number from 0 to 3.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Finalize", exact: true })).toBeDisabled();
    await four.fill("1");
    await five.fill("0");
    await dialog.getByRole("button", { name: "Finalize", exact: true }).click();

    await expect(page.getByText(/^Qualification finalized on/)).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Not played" })).toHaveCount(1);

    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await expect(cell(page, "F1", 3)).toHaveText("30.00"); // 10 dropped: (20+30+40)/3
    await expect(cell(page, "F3", 3)).toHaveText("30.00"); // nothing dropped: (10+...+50)/5
  });

  test("reopen restores the schedule and rankings", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    await page.getByRole("button", { name: "Reopen qualification" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reopen qualification" }).click();
    await expect(page.getByRole("button", { name: "Finalize qualification" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Not played" })).toHaveCount(0);
    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await expect(cell(page, "F1", 3)).toHaveText("25.00");
  });

  test("reopen is refused once finals exist", async ({ page, request }) => {
    const finalized = await request.post(api(`/api/sessions/${session}/qualification/finalize`), {
      headers: headers(),
      data: { drops: { "4": 1, "5": 1 } },
    });
    expect(finalized.ok()).toBeTruthy();
    const finals = await request.post(api("/api/finals/start"), { headers: headers(), data: { session_id: session, bracket_size: 2 } });
    expect(finals.ok()).toBeTruthy();

    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    await page.getByRole("button", { name: "Reopen qualification" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Reopen qualification" }).click();
    await expect(dialog.getByText("Delete this session's finals brackets before reopening qualification")).toBeVisible();
  });
});
