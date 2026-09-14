import { test, expect } from "@playwright/test";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

test.describe.serial("event setup: plugin install and selection", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: "Setup Test Event", password: "setup-pw" },
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
    await page.getByLabel("Password").fill("setup-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Event & plugins" }).click();
    await expect(page).toHaveURL(/\/events\/setup$/);

    const zipPath = await buildExampleGamePluginZip();
    await page.getByLabel("Install a plugin (.zip)").first().setInputFiles(zipPath);
    await expect(page.getByText(/example-game/i)).toBeVisible();

    await page.getByRole("button", { name: "Select for this event" }).click();
    await expect(page.getByText("Selected")).toBeVisible();
  });
});
