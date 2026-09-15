import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("team delete", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("deleting a team removes it from the grid", async ({ page, request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const { access_token: accessToken } = await loginResponse.json();
    await request.post("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { number: "9999Z", name: "Team To Delete" },
    });

    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await expect(page.getByText("Team To Delete")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).first().click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByText("Team To Delete")).not.toBeVisible();
  });
});
