import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";
import { ADMIN_LANDING } from "./fixtures/landing";

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
    await expect(page).toHaveURL(ADMIN_LANDING);

    await page.getByRole("link", { name: "Teams & divisions" }).click();
    await expect(page).toHaveURL(/\/teams$/);
    await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Number" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

    // A blank added row isn't unsaved until something is typed into it.
    await page.getByRole("button", { name: "Add row" }).click();
    await expect(page.getByText("unsaved")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

    const row = page.getByRole("row").last();
    await row.getByRole("gridcell").nth(0).dblclick();
    await page.getByRole("textbox").fill("9001");
    await page.keyboard.press("Tab");
    await expect(page.getByText("unsaved")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await row.getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("Grid Test Team");
    await page.keyboard.press("Tab");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("1 saved");
    await expect(page.getByText("unsaved")).toHaveCount(0);

    // Reload: the row is now genuinely on the server.
    await page.reload();
    await expect(page.getByText("Grid Test Team")).toBeVisible();

    // Renumbering an existing team edits it in place rather than creating a duplicate.
    await page.getByRole("gridcell", { name: "9001", exact: true }).dblclick();
    await page.getByRole("textbox").fill("9001F");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("1 saved");
    await page.reload();
    await expect(page.getByRole("gridcell", { name: "9001F", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "9001", exact: true })).toHaveCount(0);
    await expect(page.getByRole("gridcell", { name: "Grid Test Team", exact: true })).toHaveCount(1);

    // A blank added row isn't an unsaved change on its own.
    await page.getByRole("button", { name: "Add row" }).click();
    await expect(page.getByText("unsaved")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

    // A row with some text but no number surfaces its per-row error inline.
    await page.getByRole("row").last().getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("No Number Team");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("0 saved, 1 need fixing");
    await expect(page.getByText("number and name are required")).toBeVisible();
  });

  test("Enter in the last row starts the next team's row", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(ADMIN_LANDING);
    await page.goto("/teams");
    await expect(page.getByRole("columnheader", { name: "Number" })).toBeVisible();

    await page.getByRole("button", { name: "Add row" }).click();
    const rowCount = await page.getByRole("row").count();
    const added = page.getByRole("row").last();
    await added.getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("Enter Key Team");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("gridcell", { name: "Enter Key Team", exact: true })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(rowCount + 1);
    const next = page.getByRole("row").last();
    await expect(next.getByRole("gridcell").nth(0)).toBeFocused();

    // Typing goes straight into the new row's Number cell.
    await page.keyboard.type("9100");
    await page.keyboard.press("Tab");
    await expect(next.getByRole("gridcell").nth(0)).toHaveText("9100");
  });

  test("a team typed with Enter saves cleanly, leaving no blank row behind", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(ADMIN_LANDING);
    await page.goto("/teams");
    await expect(page.getByRole("columnheader", { name: "Number" })).toBeVisible();

    await page.getByRole("button", { name: "Add row" }).click();
    const rowCount = await page.getByRole("row").count();
    const added = page.getByRole("row").last();
    await added.getByRole("gridcell").nth(0).dblclick();
    await page.getByRole("textbox").fill("9200");
    await page.keyboard.press("Tab");
    await added.getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("Enter Saved Team");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("row")).toHaveCount(rowCount + 1);

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("1 saved");
    await expect(page.getByRole("row")).toHaveCount(rowCount);
    await expect(page.getByText("unsaved")).toHaveCount(0);
  });
});
