import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("team roster grid", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("add, edit and save a team through the grid", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);
    await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Number" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await page.getByRole("button", { name: "Add row" }).click();
    await expect(page.getByText("unsaved")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();

    const row = page.getByRole("row").last();
    await row.getByRole("gridcell").nth(0).dblclick();
    await page.getByRole("textbox").fill("9001");
    await page.keyboard.press("Tab");
    await row.getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("Grid Test Team");
    await page.keyboard.press("Tab");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("1 saved");
    await expect(page.getByText("unsaved")).toHaveCount(0);

    // Reload: the row is now genuinely on the server.
    await page.reload();
    await expect(page.getByText("Grid Test Team")).toBeVisible();

    // An invalid row surfaces its per-row error inline.
    await page.getByRole("button", { name: "Add row" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("0 saved, 1 need fixing");
    await expect(page.getByText("number and name are required")).toBeVisible();
  });
});
