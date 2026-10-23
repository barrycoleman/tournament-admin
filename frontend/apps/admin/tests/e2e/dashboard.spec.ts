import { test, expect, type Page } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

// The event name is edited on the Event & game page (it used to live on the
// Dashboard); the header shows it on every admin page.
async function openEventSetup(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
  await page.getByRole("link", { name: "Event & game" }).click();
  await expect(page).toHaveURL(/\/events\/setup$/);
}

test.describe.serial("event name editing", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("renaming the event on Event & game updates it and persists across reload", async ({
    page,
  }) => {
    await openEventSetup(page);

    await expect(page.locator(".inline-edit__value")).toHaveText(E2E_EVENT_NAME);
    await expect(page.getByRole("banner").getByRole("heading", { name: E2E_EVENT_NAME })).toBeVisible();
    await expect(page.getByLabel("Event", { exact: true })).not.toBeVisible();

    await page.getByRole("button", { name: "Edit event name" }).click();
    const nameField = page.getByLabel("Event", { exact: true });
    await nameField.fill("Renamed Regional Event");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.locator(".inline-edit__value")).toHaveText("Renamed Regional Event");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Renamed Regional Event" })).toBeVisible();
    await expect(nameField).not.toBeVisible();

    await page.reload();
    await expect(page.locator(".inline-edit__value")).toHaveText("Renamed Regional Event");
  });

  test("clicking Cancel discards an in-progress edit without saving", async ({ page }) => {
    await openEventSetup(page);

    await expect(page.locator(".inline-edit__value")).not.toHaveText("");
    const savedName = (await page.locator(".inline-edit__value").textContent()) ?? "";

    await page.getByRole("button", { name: "Edit event name" }).click();
    await page.getByLabel("Event", { exact: true }).fill("Should not be saved");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(page.locator(".inline-edit__value")).toHaveText(savedName);
    await expect(page.getByLabel("Event", { exact: true })).not.toBeVisible();

    await page.reload();
    await expect(page.locator(".inline-edit__value")).toHaveText(savedName);
  });

  test("clearing the event name entirely shows an inline error and stays in edit mode", async ({
    page,
  }) => {
    await openEventSetup(page);

    await expect(page.locator(".inline-edit__value")).not.toHaveText("");
    const savedName = (await page.locator(".inline-edit__value").textContent()) ?? "";

    await page.getByRole("button", { name: "Edit event name" }).click();
    const nameField = page.getByLabel("Event", { exact: true });
    await nameField.fill("   ");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByRole("alert")).toHaveText("Event name cannot be empty");
    await expect(nameField).toBeVisible();

    await page.reload();
    await expect(page.locator(".inline-edit__value")).toHaveText(savedName);
  });
});
