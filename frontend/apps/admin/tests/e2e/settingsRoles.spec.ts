import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("role password management", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("changing scorer's password takes effect: old rejected, new accepted", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Role passwords" }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);

    await page.getByLabel("Role").selectOption("scorer");
    await page.getByLabel("New password").fill("scorer-new-pw");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("status")).toHaveText("Password updated.");

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Role").fill("scorer");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid role or password.");

    await page.getByLabel("Password").fill("scorer-new-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");
  });

  test("revealing a role's current password via the eye icon toggle", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Role passwords" }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);

    await page.getByLabel("Role").selectOption("judge");
    const currentPasswordField = page.getByLabel("Current password");
    await expect(currentPasswordField).toHaveAttribute("type", "password");
    await expect(currentPasswordField).toHaveValue(E2E_EVENT_PASSWORD);

    await page.getByRole("button", { name: "Show password" }).click();
    await expect(currentPasswordField).toHaveAttribute("type", "text");

    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(currentPasswordField).toHaveAttribute("type", "password");
  });

  test("the revealed password updates immediately after changing it", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Role passwords" }).click();
    await page.getByLabel("Role").selectOption("attendee");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.getByLabel("Current password")).toHaveValue(E2E_EVENT_PASSWORD);

    await page.getByLabel("New password").fill("attendee-new-pw");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("status")).toHaveText("Password updated.");

    await expect(page.getByLabel("Current password")).toHaveValue("attendee-new-pw");
  });
});
