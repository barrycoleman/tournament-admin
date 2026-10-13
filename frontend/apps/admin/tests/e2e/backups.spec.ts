import os from "node:os";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "backups-e2e-pw";

test.describe.serial("backups", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let teamId = 0;
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8131, frontendPort: 5191 });
    expect((await request.post(api("/api/event"), { data: { name: "Backup League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    const team = await request.post(api("/api/teams"), { headers: headers(), data: { number: "T1", name: "Team One" } });
    teamId = (await team.json()).id;
  });

  test.afterAll(() => server?.stop());

  test("back up, change a team, restore, and the change is gone", async ({ page, request }) => {
    await login(page);
    await page.getByRole("link", { name: "Backups" }).click();
    await expect(page.getByText("No backups yet.")).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();
    const manualRow = page.getByRole("row").filter({ hasText: "Back up now (manual)" });
    await expect(manualRow).toHaveCount(1);

    const renamed = await request.patch(api(`/api/teams/${teamId}`), { headers: headers(), data: { name: "Renamed" } });
    expect(renamed.ok()).toBeTruthy();

    const bootBefore = (await (await request.get(api("/api/time-sync"))).json()).boot_id;
    await manualRow.getByRole("button", { name: "Restore" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Everything after it is replaced.");
    await dialog.getByRole("button", { name: "Restore" }).click();

    await expect
      .poll(async () => {
        try {
          return (await (await request.get(api("/api/time-sync"))).json()).boot_id;
        } catch {
          return bootBefore;
        }
      }, { timeout: 30_000 })
      .not.toBe(bootBefore);

    const team = await (await request.get(api(`/api/teams`), { headers: headers() })).json();
    expect(team.find((t: { id: number }) => t.id === teamId).name).toBe("Team One");

    await page.goto(`${server.baseUrl}/backups`);
    if (page.url().includes("/login")) await login(page);
    await page.goto(`${server.baseUrl}/backups`);
    await expect(page.getByRole("row").filter({ hasText: "Before a restore" })).toHaveCount(1);
  });

  test("changing the folder backs up there, and Use default returns", async ({ page }) => {
    const custom = path.join(os.tmpdir(), `tournament-admin-e2e-backups-${Date.now()}`);
    await login(page);
    await page.goto(`${server.baseUrl}/backups`);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Backup folder").fill(custom);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(custom)).toBeVisible();
    await expect(page.getByText("No backups yet.")).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Back up now (manual)" })).toHaveCount(1);

    await page.getByRole("button", { name: "Use default" }).click();
    await expect(page.getByText(/backups[\\/]event$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Use default" })).toHaveCount(0);
  });
});
