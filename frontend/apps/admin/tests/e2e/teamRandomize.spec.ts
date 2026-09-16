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

    // These two divisions exist so the Teams grid renders a "Division"
    // column (see the column-index-7 comment below) -- they are not the
    // full set of divisions this test needs to accept, since event
    // creation also auto-seeds a "Division 1" (see divisionIds below).
    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division One" },
    });
    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division Two" },
    });

    // The balanced-assignment algorithm can legitimately place a
    // randomly-assigned team into ANY of the event's divisions,
    // including the auto-seeded default one -- so divisionIds must be
    // the full current division list, not just the two created above.
    const allDivisionsResponse = await request.get("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const allDivisions = await allDivisionsResponse.json();
    divisionIds = allDivisions.map((d: { id: number }) => d.id);

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
    await page.getByRole("textbox").fill("8501A");
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
        const team = teams.find((t: { number: string }) => t.number === "8501A");
        return team?.division_id ?? null;
      })
      .not.toBeNull();

    const teamsResponse = await request.get("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const teams = await teamsResponse.json();
    const team = teams.find((t: { number: string }) => t.number === "8501A");
    expect(divisionIds).toContain(team.division_id);
  });
});
