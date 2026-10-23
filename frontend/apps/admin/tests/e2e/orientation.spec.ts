import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildBalancedSchedulerPluginZip, buildExampleGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "orientation-e2e-pw";
const ZONE = "America/Los_Angeles";
const TV = "Hall TV";
const AUDIENCE = "Main Fields (audience)";

test.describe.serial("admin orientation", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let page: Page;
  let device: Page;
  let saturday = 0;
  const api = (route: string) => `${server.apiUrl}${route}`;
  const url = (route: string) => `${server.baseUrl}${route}`;
  const admin = () => ({ Authorization: `Bearer ${token}` });

  async function call(request: APIRequestContext, method: "get" | "post" | "put", route: string, data?: unknown) {
    const response = await request[method](api(route), { headers: admin(), data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  async function newPage(browser: Browser): Promise<Page> {
    // A fixed zone, so the prefilled timezone and the banner's local times are predictable.
    return (await browser.newContext({ timezoneId: ZONE })).newPage();
  }

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8153, frontendPort: 5214, devicePort: 5215 });
    expect((await request.post(api("/api/event"), { data: { name: "Orientation Open", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    // The scheduler is plumbing for Generate; the game itself is chosen through the UI below.
    const scheduler = await request.post(api("/api/plugins/schedulers"), {
      headers: admin(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildBalancedSchedulerPluginZip()) },
      },
    });
    expect(scheduler.status()).toBe(201);

    page = await newPage(browser);
    await page.goto(url("/"));
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
  });

  test.afterAll(() => server?.stop());

  test("a new event lands on the setup checklist with nothing done", async () => {
    await expect(page.getByRole("heading", { name: "Get your event ready" })).toBeVisible();
    await expect(page).toHaveURL(url("/"));
    await expect(page.getByRole("img", { name: "Not done", exact: true })).toHaveCount(3);
    await expect(page.getByRole("img", { name: "Done", exact: true })).toHaveCount(0);
    await expect(page.getByText("No active session")).toBeVisible();
  });

  test("choose the game, then follow the next step to the teams", async () => {
    await page.getByRole("link", { name: "Choose the game" }).click();
    await expect(page).toHaveURL(/\/events\/setup#game-plugins$/);
    await page.getByLabel("Install a plugin (.zip)").first().setInputFiles(await buildExampleGamePluginZip());
    await expect(page.getByText("Example Scoring Game")).toBeVisible();
    await page.getByRole("button", { name: "Select for this event" }).click();
    await expect(page.getByText("Selected")).toBeVisible();
    await page.getByRole("link", { name: "add teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);
  });

  test("the division name box keeps the cursor after an add", async () => {
    await page.getByRole("link", { name: "Divisions", exact: true }).click();
    await expect(page).toHaveURL(/\/teams\/divisions$/);
    await page.getByRole("button", { name: "Add a division..." }).click();
    const name = page.getByLabel("Division name");
    await name.fill("Spare Division");
    await name.press("Enter");
    await expect(page.getByText("Spare Division", { exact: true })).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("");

    // Back to the single seeded division before any teams exist.
    await page.getByRole("listitem").filter({ hasText: "Spare Division" }).getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete this division?" });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText("Spare Division", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Teams", exact: true }).click();
    await expect(page).toHaveURL(/\/teams$/);
  });

  test("add four teams, then follow the next step to a new session", async () => {
    await page.getByRole("button", { name: "Add row" }).click();
    await page.getByRole("row").last().getByRole("gridcell").first().click();
    await page.evaluate(() => {
      const pasteData = new DataTransfer();
      pasteData.setData("text/plain", "101\tAlpha\n202\tBravo\n303\tCharlie\n404\tDelta");
      document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pasteData, bubbles: true }));
    });
    await expect(page.getByText("Delta")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("4 saved");
    await page.getByRole("link", { name: "create a session" }).click();
    await expect(page).toHaveURL(/\/sessions\/new$/);
  });

  test("a new session with a prefilled timezone lands on its Setup tab", async () => {
    await page.getByLabel("Session name").fill("Saturday");
    await page.getByLabel("Date (optional)").fill("2026-11-07");
    await expect(page.getByLabel("Timezone")).not.toHaveValue("");
    await expect(page.getByLabel("Timezone")).toHaveValue(ZONE);
    await page.getByRole("button", { name: "Add session", exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/\d+\/setup$/);
    saturday = Number(page.url().match(/\/sessions\/(\d+)\/setup$/)![1]);
    await expect(page.getByRole("link", { name: "Saturday", exact: true })).toBeVisible();
  });

  test("three fields typed into one box with Enter and no clicks", async () => {
    await page.getByLabel("Add your first field").click();
    await page.keyboard.type("Field 1");
    await page.keyboard.press("Enter");
    const card = page.getByRole("region", { name: "Main Fields" });
    const next = card.getByLabel("New field name for Main Fields");
    await expect(card.getByText("Field 1", { exact: true })).toBeVisible();
    await expect(next).toBeFocused();
    await expect(next).toHaveValue("");
    await page.keyboard.type("Field 2");
    await page.keyboard.press("Enter");
    await expect(card.getByText("Field 2")).toBeVisible();
    await expect(next).toBeFocused();
    await expect(next).toHaveValue("");
    await page.keyboard.type("Field 3");
    await page.keyboard.press("Enter");
    await expect(card.getByText("Field 3")).toBeVisible();
    await expect(next).toBeFocused();
    for (const name of ["Field 1", "Field 2", "Field 3"]) {
      await expect(card.getByText(name, { exact: true })).toBeVisible();
    }
    expect((await call(page.request, "get", `/api/fields?session_id=${saturday}`)).length).toBe(3);
  });

  test("playing times, check-in and a schedule, then Make active from Today", async () => {
    await page.getByRole("link", { name: "Schedule", exact: true }).click();
    await page.getByLabel("Playing time 1 date").fill("2026-11-07");
    await page.getByLabel("Playing time 1 start").fill("09:00");
    await page.getByLabel("Playing time 1 end").fill("12:00");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".playing-times__summary")).toHaveText("Sat 09:00–12:00");

    await page.getByRole("link", { name: "Check-In", exact: true }).click();
    await page.getByRole("button", { name: "Check in all visible" }).click();
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      await expect(page.getByLabel(`Toggle check-in for ${name}`)).toBeChecked();
    }

    await page.getByRole("link", { name: "Schedule", exact: true }).click();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();

    await page.getByRole("link", { name: "Today", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${saturday}/today$`));
    const matches = page.getByRole("region", { name: "Matches" });
    await matches.getByRole("button", { name: "Make active", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Make Saturday active?" });
    await dialog.getByRole("button", { name: "Make active", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Active: Saturday", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Saturday (active)" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Match Control", exact: true })).toBeVisible();
  });

  test("the field set name box keeps the cursor after each add", async () => {
    await page.getByRole("link", { name: "Setup", exact: true }).click();
    const box = page.getByLabel("New field set name");
    await box.click();
    await page.keyboard.type("Practice Row");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Practice Row" })).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("");
    await page.keyboard.type("Spare Row");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Spare Row" })).toBeVisible();
    await expect(box).toBeFocused();
  });

  test("pair a TV as a display that shows the audience spot", async ({ browser }) => {
    device = await newPage(browser);
    await device.goto(url("/device/"));
    const shown = device.getByTestId("pairing-code");
    await expect(shown).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const code = (await shown.textContent())!.replace(" ", "");

    await page.getByRole("link", { name: "Devices & displays" }).click();
    await expect(page).toHaveURL(/\/devices$/);
    await expect(page.getByRole("heading", { name: "Devices & displays", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Role")).toHaveValue("display_device");
    await page.getByLabel("Pairing code").fill(code);
    await expect(page.getByLabel("Device name")).not.toHaveValue("");
    await page.getByLabel("Device name").fill(TV);
    await page.getByLabel("Shows", { exact: true }).selectOption({ label: AUDIENCE });
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByText(`Paired ${TV}.`)).toBeVisible();

    // The device signs in and opens its socket after the pair call; the server
    // tells admins when it connects, so the row turns Connected without a reload.
    await expect(shown).toHaveCount(0, { timeout: 15_000 });
    await expect(device.locator(".display")).toBeVisible({ timeout: 15_000 });
    const row = page.getByRole("row").filter({ hasText: TV });
    await expect(row.getByText("● Connected")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(`What ${TV} shows`).locator("option:checked")).toHaveText(AUDIENCE);
  });

  test("Identify shows the TV's name full-screen on the device", async () => {
    const identify = page.getByRole("region", { name: "TVs and displays" }).getByRole("button", { name: `Identify ${TV}` });
    await expect(identify).toBeEnabled();
    await identify.click();
    const overlay = device.getByTestId("identify");
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    await expect(overlay).toHaveText(TV);
    // Full-screen: the overlay covers the whole viewport.
    const box = (await overlay.boundingBox())!;
    const viewport = device.viewportSize()!;
    expect(box.x).toBeLessThanOrEqual(0);
    expect(box.y).toBeLessThanOrEqual(0);
    expect(box.width).toBeGreaterThanOrEqual(viewport.width);
    expect(box.height).toBeGreaterThanOrEqual(viewport.height);
  });

  test("the old URLs land on their new homes", async () => {
    await page.goto(url("/displays"));
    await expect(page).toHaveURL(url("/devices"));
    await page.goto(url("/divisions"));
    await expect(page).toHaveURL(url("/teams/divisions"));
    await page.goto(url(`/sessions/${saturday}`));
    await expect(page).toHaveURL(url(`/sessions/${saturday}/today`));
    await page.goto(url(`/sessions/${saturday}/fields`));
    await expect(page).toHaveURL(url(`/sessions/${saturday}/setup`));
    await expect(page.getByRole("heading", { name: "Fields" })).toBeVisible();
  });

  test.describe("the next-session banner", () => {
    test("offers the next session after the cutover and copies the TV spots", async ({ request }) => {
      const pm = await call(request, "post", "/api/sessions", { label: "Saturday PM", session_date: "2026-11-07", timezone: ZONE });
      await call(request, "put", `/api/sessions/${pm.id}/playing-windows`, {
        windows: [{ date: "2026-11-07", start_time: "13:00", end_time: "17:00" }],
      });
      // A field set named like Saturday's, so the audience spot has somewhere to go.
      await call(request, "post", "/api/fields", { session_id: pm.id, name: "Field 1" });

      // Saturday ends at 12:00 and Saturday PM starts at 13:00, so the cutover is 12:30.
      await page.clock.setFixedTime(new Date("2026-11-07T12:20:00-08:00"));
      // The banner needs the PM session's playing times; wait for them so "no banner" means something.
      const pmWindows = page.waitForResponse(
        (response) => response.url().endsWith(`/api/sessions/${pm.id}/playing-windows`) && response.ok()
      );
      await page.goto(url(`/sessions/${saturday}/today`));
      await pmWindows;
      await expect(page.getByRole("link", { name: "Active: Saturday", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Saturday PM" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Make it active" })).toHaveCount(0);

      await page.clock.setFixedTime(new Date("2026-11-07T12:35:00-08:00"));
      await page.reload();
      const banner = page.locator(".active-session-banner");
      await expect(banner).toContainText("Saturday PM is scheduled to start at 13:00");
      await banner.getByRole("button", { name: "Make it active" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Make Saturday PM active?" });
      const copy = dialog.getByRole("button", { name: "Copy TV spots and make active" });
      await expect(copy).toBeEnabled();
      await copy.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Active: Saturday PM", exact: true })).toBeVisible();
      await expect(banner).toHaveCount(0);

      await page.getByRole("link", { name: "Devices & displays" }).click();
      await expect(page.getByLabel("Spots for").locator("option:checked")).toHaveText("Saturday PM (active)");
      await expect(page.getByLabel(`What ${TV} shows`).locator("option:checked")).toHaveText(AUDIENCE);
    });
  });
});
