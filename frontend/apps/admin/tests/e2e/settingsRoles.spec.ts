import { test, expect } from "@playwright/test";

test.describe.serial("role password management", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: "Roles Test Event", password: "initial-pw" },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("changing scorer's password takes effect: old rejected, new accepted", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("initial-pw");
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
    await page.getByLabel("Password").fill("initial-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid role or password.");

    await page.getByLabel("Password").fill("scorer-new-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");
  });
});
