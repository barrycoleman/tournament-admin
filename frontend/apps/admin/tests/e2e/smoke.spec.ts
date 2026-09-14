import { test, expect } from "@playwright/test";

test("the app loads and the backend is reachable through the dev proxy", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Tournament Admin")).toBeVisible();

  const response = await page.request.get("/api/event");
  // No event exists yet in this fresh temp DB.
  expect(response.status()).toBe(404);
});
