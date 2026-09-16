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
    // Target the row that was just added, not the first row in the grid --
    // every E2E spec shares one backend and one event, so by the time this
    // runs the roster may already hold rows created by another spec.
    const numberCell = page.getByRole("row").last().getByRole("gridcell").first();
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

  test("re-uploading the same CSV file makes no change", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    const csvContent =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      "9201A,Reupload Team,,,,,,\n";

    await page.getByLabel("Upload CSV").setInputFiles({
      name: "teams.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("saved");

    // Re-upload the identical, unmodified file: this must not resurrect the
    // "unsaved" indicator or add a second row for the same team.
    await page.getByLabel("Upload CSV").setInputFiles({
      name: "teams.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });

    await expect(page.getByText("Reupload Team")).toHaveCount(1);
    await expect(page.getByText("unsaved")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("re-uploading a CSV file with an edited row updates it instead of duplicating it", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByLabel("Upload CSV").setInputFiles({
      name: "teams.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
          "9301A,Original Name,,,,,,\n"
      ),
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("saved");

    // A re-saved copy of the roster with this team's name changed -- same
    // number, different data. This must edit the one existing row, not add
    // a second one for team 9301A.
    await page.getByLabel("Upload CSV").setInputFiles({
      name: "teams.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
          "9301A,Edited Name,,,,,,\n"
      ),
    });

    await expect(page.getByText("9301A")).toHaveCount(1);
    await expect(page.getByText("Edited Name")).toBeVisible();
    await expect(page.getByText("Original Name")).toHaveCount(0);
    await expect(page.getByText("unsaved").first()).toBeVisible();

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("saved");
  });
});
