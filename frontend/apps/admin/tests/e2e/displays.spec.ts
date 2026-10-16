import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "displays-e2e-pw";

test.describe.serial("display groups", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let fieldOne = 0;
  let fieldTwo = 0;
  let pitGroup = 0;
  const teams: number[] = [];
  const matches: Record<string, { id: number; alliances: { id: number; station: string }[] }> = {};
  const devices: Record<string, number> = {};
  const screens: Record<string, Page> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function call(request: APIRequestContext, method: "post" | "put" | "patch", route: string, data: unknown) {
    const response = await request[method](api(route), { headers: headers(), data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  async function pairDisplay(browser: Browser, request: APIRequestContext, name: string) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    devices[name] = paired.id;
    screens[name] = page;
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    return page;
  }

  async function adminPage(browser: Browser, path: string): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    return page;
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8133, frontendPort: 5194, devicePort: 5195 });
    expect((await request.post(api("/api/event"), { data: { name: "Display League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "sample_cooperative" });
    for (const [number, name] of [["11A", "Alpha"], ["22B", "Bravo"], ["33C", "Charlie"], ["44D", "Delta"]]) {
      teams.push((await call(request, "post", "/api/teams", { number, name })).id);
    }
    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    const fieldSet = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: fieldSet, name: "Field 1" })).id;
    fieldTwo = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: fieldSet, name: "Field 2" })).id;
    const start = Date.now() + 10 * 60_000;
    const plan: [string, number, number, number, number][] = [
      ["Q1", 1, fieldOne, 0, 1],
      ["Q2", 2, fieldTwo, 2, 3],
      ["Q3", 3, fieldOne, 1, 2],
      ["Q4", 4, fieldTwo, 3, 0],
    ];
    for (const [label, number, field, red, blue] of plan) {
      matches[label] = await call(request, "post", "/api/matches", {
        session_id: saturday,
        round_type: "qualification",
        match_number: number,
        field_id: field,
        scheduled_time: new Date(start + number * 5 * 60_000).toISOString(),
        alliances: [
          { station: "red", team_ids: [teams[red]] },
          { station: "blue", team_ids: [teams[blue]] },
        ],
      });
    }
  });

  test.afterAll(() => server?.stop());

  test("an unassigned display shows its name, and the Displays page places it", async ({ browser, request }) => {
    const fieldTv = await pairDisplay(browser, request, "Field TV");
    await expect(fieldTv.getByText("Not set up for this session")).toBeVisible();
    await pairDisplay(browser, request, "Big TV");

    const admin = await adminPage(browser, "/displays");
    await expect(admin.getByRole("heading", { name: "Displays", level: 1 })).toBeVisible();
    const unassigned = admin.getByRole("region", { name: "Unassigned displays" });
    await unassigned.getByLabel("Put Field TV in a group").selectOption({ label: "Main Fields › Field 1" });
    await expect(admin.getByRole("region", { name: "Main Fields" }).getByText("Field TV")).toBeVisible();
    await admin
      .getByRole("region", { name: "Unassigned displays" })
      .getByLabel("Put Big TV in a group")
      .selectOption({ label: "Main Fields (audience)" });

    await expect(fieldTv.getByRole("heading", { name: "Qualification 1" })).toBeVisible({ timeout: 10_000 });
    await expect(fieldTv.getByTestId("bar-all")).toContainText("11A");
    await expect(fieldTv.getByTestId("start")).toHaveAttribute("data-band", "early");
    await expect(screens["Big TV"].getByRole("heading", { name: "Display League" })).toBeVisible({ timeout: 10_000 });
  });

  test("Match Control starts the next match and the audience switches to In Match", async ({ browser }) => {
    const admin = await adminPage(browser, "/match-control");
    await expect(admin.getByRole("region", { name: "Next match" }).getByText("Q1 · Field 1")).toBeVisible();
    await admin.getByRole("button", { name: "Start", exact: true }).click();
    await expect(screens["Big TV"].getByTestId("count-in").or(screens["Big TV"].getByTestId("clock"))).toBeVisible({ timeout: 10_000 });
    await expect(screens["Field TV"].getByTestId("count-in").or(screens["Field TV"].getByTestId("clock"))).toBeVisible();
    await expect(screens["Big TV"].getByText("Driver control")).toBeVisible({ timeout: 10_000 });

    const timer = admin.getByRole("region", { name: "Timer" });
    await timer.getByRole("button", { name: "End early" }).click();
    await admin.getByRole("alertdialog").getByRole("button", { name: "End early" }).click();
    await expect(screens["Field TV"].getByText("Match over")).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByText("Match over")).toBeVisible();
  });

  test("saving the score moves the field display on and Last Scored Match shows it", async ({ browser, request }) => {
    const red = matches.Q1.alliances.find((a) => a.station === "red")!;
    await call(request, "post", `/api/matches/${matches.Q1.id}/alliances/${red.id}/score`, { data: { score: 42 } });
    await expect(screens["Field TV"].getByRole("heading", { name: "Qualification 3" })).toBeVisible({ timeout: 10_000 });

    const admin = await adminPage(browser, "/match-control");
    const audience = admin.getByRole("region", { name: "Audience screen" });
    await audience.getByRole("button", { name: "Last Scored Match" }).click();
    await expect(screens["Big TV"].getByRole("heading", { name: "Qualification 1" })).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByTestId("score-all")).toHaveText("42");
  });

  test("an override changes what Start begins", async ({ browser, request }) => {
    const admin = await adminPage(browser, "/match-control");
    const next = admin.getByRole("region", { name: "Next match" });
    await expect(next.getByText("Q2 · Field 2")).toBeVisible();
    await next.getByRole("button", { name: "Change" }).click();
    await next.getByLabel("Queue match").selectOption({ label: "Q4 · Field 2" });
    await expect(next.getByText("Q4 · Field 2")).toBeVisible();
    await admin.getByRole("button", { name: "Start", exact: true }).click();
    await expect(screens["Big TV"].getByRole("heading", { name: "Qualification 4" })).toBeVisible({ timeout: 10_000 });
    await call(request, "post", `/api/matches/${matches.Q4.id}/end`, {});
  });

  test("a time-out shows on the field display and clears", async ({ browser }) => {
    const admin = await adminPage(browser, "/match-control");
    const timeout = admin.getByRole("region", { name: "Time-out" });
    await timeout.getByLabel("Length in seconds").fill("60");
    await timeout.getByRole("button", { name: "Start time-out" }).click();
    await expect(screens["Field TV"].getByRole("heading", { name: "Time-out" })).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByRole("heading", { name: "Time-out" })).toBeVisible({ timeout: 10_000 });
    await timeout.getByRole("button", { name: "Cancel time-out" }).click();
    await expect(screens["Field TV"].getByRole("heading", { name: "Time-out" })).toHaveCount(0, { timeout: 10_000 });
    await expect(screens["Big TV"].getByRole("heading", { name: "Time-out" })).toHaveCount(0, { timeout: 10_000 });
  });

  test("a pit rotation moves to its next screen", async ({ request }) => {
    const pit = await call(request, "post", "/api/displays/pit-groups", { session_id: saturday, name: "Pits" });
    await call(request, "patch", `/api/displays/groups/${pit.id}`, {
      rotation: [
        { screen: "logo", seconds: 5 },
        { screen: "upcoming_matches", seconds: 5 },
      ],
    });
    pitGroup = pit.id;
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: devices["Big TV"], group_id: pit.id });
    await expect(screens["Big TV"].getByRole("heading", { name: "Display League" })).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByRole("heading", { name: "Upcoming Matches" })).toBeVisible({ timeout: 15_000 });
  });

  test("a long schedule scrolls inside a bounded area", async ({ request }) => {
    // Screens that show times wait for the session's time zone (they never fall back to the TV's).
    // A session edit sends no live event, so reload the TV to read the new zone at once.
    await call(request, "patch", `/api/sessions/${saturday}`, { timezone: "UTC" });
    await screens["Big TV"].reload();
    const start = Date.now() + 60 * 60_000;
    for (let number = 5; number <= 34; number += 1) {
      await call(request, "post", "/api/matches", {
        session_id: saturday,
        round_type: "qualification",
        match_number: number,
        field_id: fieldTwo,
        scheduled_time: new Date(start + number * 5 * 60_000).toISOString(),
        alliances: [
          { station: "red", team_ids: [teams[number % 4]] },
          { station: "blue", team_ids: [teams[(number + 1) % 4]] },
        ],
      });
    }
    const wall = await call(request, "post", "/api/displays/pit-groups", { session_id: saturday, name: "Schedule Wall" });
    await call(request, "patch", `/api/displays/groups/${wall.id}`, { rotation: [{ screen: "schedule", seconds: 60 }] });
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: devices["Big TV"], group_id: wall.id });

    const bigTv = screens["Big TV"];
    await expect(bigTv.getByRole("table", { name: "Match Schedule" }).getByRole("row", { name: /Q34/ })).toBeAttached({ timeout: 10_000 });
    const area = bigTv.locator(".scroll-area");
    const size = await area.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, bottom: box.bottom };
    });
    expect(size.scrollHeight).toBeGreaterThan(size.clientHeight);
    expect(size.bottom).toBeLessThanOrEqual(720);
    // After its pause at the top, the list starts to scroll.
    await expect.poll(() => area.evaluate((element) => element.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0);

    // Back to the Pits rotation, which the copy test below expects.
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: devices["Big TV"], group_id: pitGroup });
  });

  test("copying displays into a new session keeps every display in its place", async ({ browser, request }) => {
    const sunday = (await call(request, "post", "/api/sessions", { label: "Sunday" })).id;
    await call(request, "post", `/api/sessions/${sunday}/copy-fields`, { source_session_id: saturday });
    const admin = await adminPage(browser, "/displays");
    await admin.getByLabel("Session").selectOption({ label: "Sunday" });
    const copy = admin.getByRole("region", { name: "Copy displays" });
    await copy.getByLabel("Copy from").selectOption({ label: "Saturday" });
    await copy.getByRole("button", { name: "Copy displays" }).click();
    await expect(admin.getByRole("region", { name: "Main Fields" }).getByText("Field TV")).toBeVisible();

    await call(request, "post", "/api/event/active-session", { session_id: sunday });
    await expect(screens["Field TV"].getByText("No more matches on this field")).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByRole("heading", { name: "Display League" })).toBeVisible({ timeout: 10_000 });
  });
});
