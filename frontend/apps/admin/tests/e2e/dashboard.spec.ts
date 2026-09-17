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

    const nameField = page.getByLabel("Event");
    await expect(nameField).toHaveValue(E2E_EVENT_NAME);

    await nameField.fill("Renamed Regional Event");
    await nameField.blur();

    await page.reload();
    await expect(page.getByLabel("Event")).toHaveValue("Renamed Regional Event");
  });

  test("clearing the event name entirely shows an inline error and keeps the last saved name", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const nameField = page.getByLabel("Event");
    const savedName = await nameField.inputValue();

    await nameField.fill("   ");
    await nameField.blur();

    await expect(page.getByRole("alert")).toHaveText("Event name cannot be empty");

    await page.reload();
    await expect(page.getByLabel("Event")).toHaveValue(savedName);
  });
});
