import { test, expect, type Browser, type Page } from "@playwright/test";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "pairing-e2e-pw";

test.describe.serial("device pairing", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;

  async function adminPage(browser: Browser, path = "/devices"): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("heading", { name: "Devices", level: 1 })).toBeVisible();
    return page;
  }

  async function devicePage(browser: Browser): Promise<{ page: Page; code: string }> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const shown = page.getByTestId("pairing-code");
    await expect(shown).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    return { page, code: (await shown.textContent())!.replace(" ", "") };
  }

  async function pair(admin: Page, code: string, name: string, role = "Scorer") {
    await admin.getByLabel("Pairing code").fill(code);
    await expect(admin.getByLabel("Device name")).not.toHaveValue("");
    await admin.getByLabel("Role").selectOption({ label: role });
    await admin.getByLabel("Device name").fill(name);
    await admin.getByRole("button", { name: "Pair" }).click();
    await expect(admin.getByText(`Paired ${name}.`)).toBeVisible();
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8132, frontendPort: 5192, devicePort: 5193 });
    const created = await request.post(`${server.apiUrl}/api/event`, { data: { name: "Pairing League", password: PASSWORD } });
    expect(created.status()).toBe(201);
  });

  test.afterAll(() => server?.stop());

  test("pair a scorer, stay paired after a reload, disable, enable and delete", async ({ browser }) => {
    const device = await devicePage(browser);
    const admin = await adminPage(browser);
    await pair(admin, device.code.toLowerCase(), "Field 1 Tablet");

    await expect(device.page.getByText("Paired as")).toBeVisible({ timeout: 10_000 });
    await expect(device.page.getByText("Field 1 Tablet")).toBeVisible();
    await expect(device.page.getByText(/Scorer/)).toBeVisible();
    await device.page.reload();
    await expect(device.page.getByText("Paired as")).toBeVisible();
    await expect(device.page.getByText("Field 1 Tablet")).toBeVisible();

    const row = admin.getByRole("row").filter({ hasText: "Field 1 Tablet" });
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByText("Disabled")).toBeVisible();
    await expect(device.page.getByText("This device is disabled.")).toBeVisible({ timeout: 10_000 });

    await row.getByRole("button", { name: "Enable" }).click();
    // The blocked screen names the device too ("Ask an admin to enable ..."),
    // so wait for the home screen itself. A disabled device rechecks every 30 s.
    await expect(device.page.getByText("Paired as")).toBeVisible({ timeout: 40_000 });
    await expect(device.page.getByText("Field 1 Tablet")).toBeVisible();

    await row.getByRole("button", { name: "Delete" }).click();
    const dialog = admin.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete Field 1 Tablet? It will need to be paired again.");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(admin.getByRole("row").filter({ hasText: "Field 1 Tablet" })).toHaveCount(0);
    await expect(device.page.getByTestId("pairing-code")).toBeVisible({ timeout: 10_000 });
  });

  test("the QR link fills in and checks the code after signing in", async ({ browser }) => {
    const device = await devicePage(browser);
    const admin = await adminPage(browser, `/devices?pair=${device.code}`);
    await expect(admin.getByLabel("Pairing code")).toHaveValue(device.code);
    await expect(admin.getByLabel("Device name")).not.toHaveValue("");
  });

  test("an unknown or expired code is refused", async ({ browser }) => {
    const admin = await adminPage(browser);
    await admin.getByLabel("Pairing code").fill("AAA AAA");
    await expect(admin.getByText("That code isn't valid or has expired.")).toBeVisible();
    await expect(admin.getByRole("button", { name: "Pair" })).toBeDisabled();
  });

  test("pairing a device in the admin's own browser keeps the admin signed in", async ({ browser }) => {
    const admin = await adminPage(browser);
    const sameBrowser = await admin.context().newPage();
    await sameBrowser.goto(`${server.baseUrl}/pair`);
    const code = (await sameBrowser.getByTestId("pairing-code").textContent())!.replace(" ", "");
    await pair(admin, code, "Admin Laptop Display", "Display");
    // A paired display runs display mode, which shows its name until it is given a group.
    await expect(sameBrowser.getByRole("heading", { name: "Admin Laptop Display" })).toBeVisible({ timeout: 10_000 });
    await admin.reload();
    await expect(admin.getByRole("heading", { name: "Devices", level: 1 })).toBeVisible();
  });
});
