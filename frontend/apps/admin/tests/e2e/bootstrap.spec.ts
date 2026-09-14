import { test, expect } from "@playwright/test";

test.describe.serial("bootstrap: event creation, login, and the authenticated shell", () => {
  test("a fresh install redirects to /events/new", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/events\/new$/);
    await expect(page.getByRole("heading", { name: "Set up your event" })).toBeVisible();
  });

  test("creating the event redirects to /login", async ({ page }) => {
    await page.goto("/events/new");
    await page.getByLabel("Event name").fill("Regional Qualifier");
    await page.getByLabel(/Initial password/).fill("bootstrap-pw");
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("bad credentials show an inline error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid role or password.");
  });

  test("logging in as admin lands on the dashboard showing the event name", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText("Event: Regional Qualifier")).toBeVisible();
  });

  test("a session close to expiry is silently refreshed without forcing a re-login", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const originalRefreshToken = await page.evaluate(() => {
      const stored = JSON.parse(
        localStorage.getItem("tournament-admin.auth.v1") ?? "null"
      );
      const nearExpiry = { ...stored, expiresAt: Date.now() + 2_000 };
      localStorage.setItem("tournament-admin.auth.v1", JSON.stringify(nearExpiry));
      return stored.refreshToken as string;
    });

    await page.reload();
    await expect(page.getByText("Event: Regional Qualifier")).toBeVisible();

    // The silent-refresh timer (30s before expiresAt, so immediately for
    // a 2s-out expiry) should have rotated the refresh token by now,
    // without the user ever seeing a login screen.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const stored = JSON.parse(
            localStorage.getItem("tournament-admin.auth.v1") ?? "null"
          );
          return stored?.refreshToken as string | undefined;
        })
      )
      .not.toBe(originalRefreshToken);
    await expect(page).toHaveURL("/");
  });

  test("explicit logout revokes the refresh token server-side and redirects to /login", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const refreshToken = await page.evaluate(() => {
      const stored = JSON.parse(
        localStorage.getItem("tournament-admin.auth.v1") ?? "null"
      );
      return stored.refreshToken as string;
    });

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    const reuseResponse = await page.request.post("/api/auth/refresh", {
      data: { refresh_token: refreshToken },
    });
    expect(reuseResponse.status()).toBe(401);
  });
});
