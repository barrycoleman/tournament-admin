import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("division management", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("create, rename, and delete a division", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Divisions" }).click();
    await expect(page).toHaveURL(/\/divisions$/);

    // Event creation always seeds one division ("Division 1"); as the
    // only division, its delete button must not be present at all.
    await expect(page.getByLabel("Rename Division 1")).toHaveValue("Division 1");
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // The create form starts hidden behind a toggle button.
    await expect(page.getByLabel("Division name")).not.toBeVisible();
    await page.getByRole("button", { name: "Add a division..." }).click();

    await page.getByLabel("Division name").fill("Elementary");
    await page.getByRole("button", { name: "Add division" }).click();
    // The division's name only ever appears as the value of its inline
    // rename <input> (there's no separate read-only text node for it),
    // so it must be asserted via that input's accessible name/value
    // rather than getByText.
    await expect(page.getByLabel("Rename Elementary")).toHaveValue("Elementary");

    // With two divisions now, both rows show a delete button.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(2);

    // Each row's rename input has its own accessible name ("Rename
    // <current name>"), distinct from the add-form's "Division name"
    // label above, so this targets the new row's input specifically.
    const renameInput = page.getByLabel("Rename Elementary");
    await renameInput.fill("Elementary School");
    await renameInput.press("Tab"); // triggers the input's onBlur handler
    await expect(page.getByLabel("Rename Elementary School")).toHaveValue("Elementary School");

    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByLabel("Rename Elementary School")).not.toBeVisible();

    // Back down to one division -- its delete button is hidden again.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });
});
