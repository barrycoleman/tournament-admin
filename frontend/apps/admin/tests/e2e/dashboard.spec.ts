import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("dashboard: event name editing", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("renaming the event via the dashboard updates it and persists across reload", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await expect(page.getByText(E2E_EVENT_NAME)).toBeVisible();
    await expect(page.getByLabel("Event", { exact: true })).not.toBeVisible();

    await page.getByRole("button", { name: "Edit event name" }).click();
    const nameField = page.getByLabel("Event", { exact: true });
    await nameField.fill("Renamed Regional Event");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Renamed Regional Event")).toBeVisible();
    await expect(nameField).not.toBeVisible();

    await page.reload();
    await expect(page.getByText("Renamed Regional Event")).toBeVisible();
  });

  test("clicking Cancel discards an in-progress edit without saving", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const savedName = (await page.locator(".inline-edit__value").textContent()) ?? "";

    await page.getByRole("button", { name: "Edit event name" }).click();
    await page.getByLabel("Event", { exact: true }).fill("Should not be saved");
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByText(savedName)).toBeVisible();
    await expect(page.getByLabel("Event", { exact: true })).not.toBeVisible();

    await page.reload();
    await expect(page.getByText(savedName)).toBeVisible();
  });

  test("clearing the event name entirely shows an inline error and stays in edit mode", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const savedName = (await page.locator(".inline-edit__value").textContent()) ?? "";

    await page.getByRole("button", { name: "Edit event name" }).click();
    const nameField = page.getByLabel("Event", { exact: true });
    await nameField.fill("   ");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("alert")).toHaveText("Event name cannot be empty");
    await expect(nameField).toBeVisible();

    await page.reload();
    await expect(page.getByText(savedName)).toBeVisible();
  });
});
