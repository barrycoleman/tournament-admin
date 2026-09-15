import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("team paste and CSV upload", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("pasting multi-row tab-delimited data populates and saves multiple teams", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Add row" }).click();
    const numberCell = page.getByRole("gridcell").first();
    await numberCell.click();

    await page.evaluate(() => {
      const pasteData = new DataTransfer();
      pasteData.setData("text/plain", "8001A\tPaste Team One\n8002B\tPaste Team Two");
      const target = document.activeElement;
      target?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: pasteData, bubbles: true })
      );
    });

    await expect(page.getByText("Paste Team One")).toBeVisible();
    await expect(page.getByText("Paste Team Two")).toBeVisible();

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("saved");
  });

  test("uploading a CSV file appends parsed rows to the grid", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    const csvContent =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      "9101A,CSV Team One,,,,,,\n" +
      "9102B,CSV Team Two,,,,,,\n";

    await page.getByLabel("Upload CSV").setInputFiles({
      name: "teams.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });

    await expect(page.getByText("CSV Team One")).toBeVisible();
    await expect(page.getByText("CSV Team Two")).toBeVisible();
    await expect(page.getByText("unsaved").first()).toBeVisible();

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("saved");
  });
});
