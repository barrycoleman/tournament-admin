import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("randomize unassigned teams", () => {
  let accessToken = "";
  let divisionIds: number[] = [];

  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const body = await loginResponse.json();
    accessToken = body.access_token as string;

    const divisionOneResponse = await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division One" },
    });
    const divisionTwoResponse = await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division Two" },
    });
    const divisionOne = await divisionOneResponse.json();
    const divisionTwo = await divisionTwoResponse.json();
    divisionIds = [divisionOne.id, divisionTwo.id];

    await request.post("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { number: "7001A", name: "Unassigned Team" },
    });
  });

  test("clicking the button assigns previously-unassigned teams", async ({ page, request }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Randomly assign unassigned teams" }).click();

    await expect
      .poll(async () => {
        const teamsResponse = await request.get("/api/teams", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const teams = await teamsResponse.json();
        const team = teams.find((t: { number: string }) => t.number === "7001A");
        return team?.division_id ?? null;
      })
      .not.toBeNull();
  });

  test("selecting (random) for a new row's division assigns it a real division on save", async ({
    page,
    request,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Add row" }).click();

    const row = page.getByRole("row").last();
    await row.getByRole("gridcell").nth(0).dblclick();
    await page.getByRole("textbox").fill("8001A");
    await page.keyboard.press("Tab");
    await row.getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("Random Division Team");
    await page.keyboard.press("Tab");

    // Division is column index 7 (number, name, robot_name, organization,
    // city, state, country, division) -- present because this describe
    // block's beforeAll creates two divisions, so the grid shows the column.
    await row.getByRole("gridcell").nth(7).dblclick();
    await row.getByRole("combobox").selectOption({ label: "(random)" });
    await expect(row.getByRole("gridcell").nth(7)).toHaveText("(random)");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("1 saved");
    await expect(page.getByText("Random Division Team")).toBeVisible();

    await expect
      .poll(async () => {
        const teamsResponse = await request.get("/api/teams", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const teams = await teamsResponse.json();
        const team = teams.find((t: { number: string }) => t.number === "8001A");
        return team?.division_id ?? null;
      })
      .not.toBeNull();

    const teamsResponse = await request.get("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const teams = await teamsResponse.json();
    const team = teams.find((t: { number: string }) => t.number === "8001A");
    expect(divisionIds).toContain(team.division_id);
  });
});
