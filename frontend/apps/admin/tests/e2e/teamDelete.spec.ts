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
    // Scope to this team's own row rather than `.first()`: the roster is
    // one shared table across every E2E spec file, so other specs'
    // teams (e.g. sessionCheckin.spec.ts's "9001A"/"9002A", created
    // earlier in the same run) can easily outnumber or sort ahead of this
    // one -- `.first()` silently deleted the wrong row once that stopped
    // being the only team on the grid.
    await page
      .getByRole("row")
      .filter({ hasText: "Team To Delete" })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByText("Team To Delete")).not.toBeVisible();
  });

  test("the Delete button is reachable and usable from the keyboard", async ({ page, request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const { access_token: accessToken } = await loginResponse.json();
    await request.post("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { number: "9998K", name: "Keyboard Delete Team" },
    });

    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    const row = page.getByRole("row").filter({ hasText: "Keyboard Delete Team" });
    await row.getByRole("gridcell").first().click();

    // End lands on the last column (status). Measured after a key press,
    // since only keyboard focus matches :focus-visible: the active cell's
    // outline must sit inside the cell, or the neighbouring cells to the
    // right and below paint over it.
    await page.keyboard.press("End");
    const outlineOffset = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineOffset
    );
    expect(parseFloat(outlineOffset)).toBeLessThan(0);

    // One step left is the Delete column; the grid should hand focus to
    // the button inside it.
    await page.keyboard.press("ArrowLeft");
    await expect(row.getByRole("button", { name: "Delete" })).toBeFocused();

    // Opening the dialog moves focus into it, onto the safe choice.
    const deleteButton = row.getByRole("button", { name: "Delete" });
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    // Escape cancels and puts focus back on the button that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(deleteButton).toBeFocused();

    // Reopen and confirm, still keyboard only: Shift+Tab from Cancel to Delete.
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Keyboard Delete Team")).not.toBeVisible();
  });
});
