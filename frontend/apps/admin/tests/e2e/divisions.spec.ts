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
    await expect(page.getByText("Division 1")).toBeVisible();
    await expect(page.getByLabel("Rename Division 1")).not.toBeVisible();
    // This counts every "Delete"-named button anywhere on the page, which
    // is only correct because no other spec file that could run before
    // this one (given this suite's fixed workers: 1 / fullyParallel: false
    // ordering) creates a division of its own.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // The create form starts hidden behind a toggle button.
    await expect(page.getByLabel("Division name")).not.toBeVisible();
    await page.getByRole("button", { name: "Add a division..." }).click();

    await page.getByLabel("Division name").fill("Elementary");
    await page.getByRole("button", { name: "Add division" }).click();
    await expect(page.getByText("Elementary", { exact: true })).toBeVisible();

    // With two divisions now, both rows show a delete button.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(2);

    // Renaming requires an explicit edit -> save action; there is no
    // save-on-blur.
    await page.getByRole("button", { name: "Edit Elementary" }).click();
    const renameInput = page.getByLabel("Rename Elementary");
    await renameInput.fill("Elementary School");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Elementary School")).toBeVisible();
    await expect(renameInput).not.toBeVisible();

    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByText("Elementary School")).not.toBeVisible();

    // Back down to one division -- its delete button is hidden again.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });

  test("editing a division name shows Save/Cancel and Cancel discards the edit", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Divisions" }).click();
    await expect(page).toHaveURL(/\/divisions$/);

    await page.getByRole("button", { name: "Edit Division 1" }).click();
    const renameInput = page.getByLabel("Rename Division 1");
    await renameInput.fill("Should not be saved");
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByText("Division 1")).toBeVisible();
    await expect(renameInput).not.toBeVisible();

    await page.reload();
    await expect(page.getByText("Division 1")).toBeVisible();
  });
});
