import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("session check-in", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const { access_token: token } = await loginResponse.json();

    for (const number of ["9001A", "9002A"]) {
      const response = await request.post("/api/teams", {
        headers: { Authorization: `Bearer ${token}` },
        data: { number, name: `Checkin Team ${number}` },
      });
      expect([201, 409]).toContain(response.status());
    }
  });

  test("admin creates a session and checks in a team; front_desk sees and extends it; admin sees the result", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Sessions" }).click();
    await expect(page).toHaveURL(/\/sessions$/);

    await page.getByRole("button", { name: "Add session..." }).click();
    await page.getByLabel("Label").fill("Check-In Day");
    await page.getByRole("button", { name: "Add session", exact: true }).click();
    await expect(page.getByText("Check-In Day")).toBeVisible();

    await page.getByRole("link", { name: "Check-In Day" }).click();
    await expect(page).toHaveURL(/\/sessions\/\d+\/checkin$/);
    const sessionId = page.url().match(/\/sessions\/(\d+)\//)?.[1];
    expect(sessionId).toBeTruthy();

    // A plain `.click()` + polling `toBeChecked()` assertion, rather than
    // `.check()` (which does its own single, immediate post-click
    // verification): the grid's toggle mutation briefly flips the row's
    // `useMutation` result identity to "pending" as soon as it's fired,
    // which recomputes this cell's memoized column definition and causes
    // react-data-grid to re-render the checkbox from the still-stale
    // (unchecked) cached participants data for one tick, before the
    // mutation's own response invalidates that cache and the box settles
    // checked. `.check()`'s one-shot verification catches that one tick
    // and fails; polling past it is the correct wait here, not a
    // workaround for an app bug.
    const firstRowCheckbox = page.getByLabel(/Toggle check-in for Checkin Team 9001A/);
    await firstRowCheckbox.click();
    await expect(firstRowCheckbox).toBeChecked();

    // `page.request` is a separate, unauthenticated HTTP context from the
    // page's own fetches -- it does not pick up the bearer token the admin
    // UI stores in localStorage, so this call needs that token passed
    // explicitly or it 401s and never actually sets the active session.
    const adminToken = await page.evaluate(() => {
      const raw = localStorage.getItem("tournament-admin.auth.v1");
      return raw ? (JSON.parse(raw) as { accessToken: string }).accessToken : null;
    });
    expect(adminToken).toBeTruthy();
    const activeSessionResponse = await page.request.post("/api/event/active-session", {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { session_id: Number(sessionId) },
    });
    expect(activeSessionResponse.status()).toBe(200);

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL("/login");

    await page.getByLabel("Role").fill("front_desk");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    // LoginRoute always navigates to "/" after login, but the index
    // route's own loader redirects front_desk straight on to /checkin
    // (its shell only ever shows that one link anyway, and "/" renders
    // the admin-only Dashboard) -- so front_desk lands on /checkin
    // directly, without an intermediate visit to "/" or a nav click.
    await expect(page).toHaveURL("/checkin");

    await expect(page.getByRole("link", { name: "Check-In" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sessions" })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Divisions" })).not.toBeVisible();

    await expect(page.getByText(/9001A/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Checked In" })).toBeVisible();

    await page.getByLabel("Search by team number or name").fill("9002A");
    await page.getByRole("button", { name: "Check In", exact: true }).click();
    await expect(page.getByRole("button", { name: "Checked In" })).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    // Wait for login to actually land before navigating away by URL --
    // otherwise `page.goto` below can race the login call and fire before
    // tokens are persisted, bouncing back to /login.
    await expect(page).toHaveURL("/");
    await page.goto(`/sessions/${sessionId}/checkin`);

    await expect(page.getByLabel(/Toggle check-in for Checkin Team 9002A/)).toBeChecked();
  });
});
