import { test, expect } from "@playwright/test";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("event setup: plugin install and selection", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    // Ignore 409 (already created by a prior spec file's run against the
    // same backend instance) — this suite only needs an event to exist.
    expect([201, 409]).toContain(createResponse.status());
  });

  test("installing and selecting a game plugin reflects on the dashboard", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Event & plugins" }).click();
    await expect(page).toHaveURL(/\/events\/setup$/);

    const zipPath = await buildExampleGamePluginZip();
    await page.getByLabel("Install a plugin (.zip)").first().setInputFiles(zipPath);
    await expect(page.getByText("Example Scoring Game")).toBeVisible();

    await page.getByRole("button", { name: "Select for this event" }).click();
    await expect(page.getByText("Selected")).toBeVisible();
  });
});
