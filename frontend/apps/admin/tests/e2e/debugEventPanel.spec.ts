import { test, expect } from "@playwright/test";

test.describe.serial("debug event panel", () => {
  let accessToken = "";

  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: "Debug Panel Test Event", password: "debug-pw" },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: "debug-pw" },
    });
    expect(loginResponse.status()).toBe(200);
    const body = await loginResponse.json();
    accessToken = body.access_token as string;

    const sessionResponse = await request.post("/api/sessions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { label: "Day 1" },
    });
    expect(sessionResponse.status()).toBe(201);
  });

  test("an active_session_changed event triggered out-of-band appears once the panel is open", async ({
    page,
    request,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("debug-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("button", { name: /Debug events/ }).click();

    const sessionsResponse = await request.get("/api/sessions", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sessions = await sessionsResponse.json();
    const sessionId = sessions[0].id as number;

    await request.post("/api/event/active-session", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { session_id: sessionId },
    });

    await expect(page.getByText("active_session_changed")).toBeVisible();
  });
});
