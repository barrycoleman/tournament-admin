import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("randomize unassigned teams", () => {
  let accessToken = "";

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

    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division One" },
    });
    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division Two" },
    });
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
});
