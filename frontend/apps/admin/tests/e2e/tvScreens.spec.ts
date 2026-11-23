import fs from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildExampleGamePluginZip, buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "tv-screens-e2e-pw";
const LONG_NAME = "The Extraordinarily Long Robotics Team Na"; // 40 characters
const TEAMS: [string, string][] = [
  ["83897A", LONG_NAME.slice(0, 40)],
  ["10480B", "Bravo"],
  ["19533Z", "Charlie"],
  ["94927X", "Delta"],
  ["55210C", "Echo"],
  ["31415P", "Foxtrot"],
];

interface MatchInfo {
  id: number;
  alliances: { id: number; station: string; team_ids: number[] }[];
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

/** Each element shows all of its content, sits inside the viewport, and keeps
 * any fitted text inside its own box; the band, clock and bottom bar never overlap. */
async function expectFits(page: Page, testIds: string[]) {
  const viewport = page.viewportSize()!;
  const boxes: Record<string, Box> = {};
  for (const id of testIds) {
    const element = page.getByTestId(id);
    await expect(element, id).toBeVisible();
    const size = await element.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(size.scrollWidth, `${id} width`).toBeLessThanOrEqual(size.clientWidth + 1);
    expect(size.scrollHeight, `${id} height`).toBeLessThanOrEqual(size.clientHeight + 1);
    const box = await element.boundingBox();
    expect(box, `${id} box`).not.toBeNull();
    if (!box) return;
    expect(box.x, `${id} left`).toBeGreaterThanOrEqual(-1);
    expect(box.y, `${id} top`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${id} right`).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(viewport.height + 1);
    // Fitted text (team numbers, the clock) is scaled down to stay inside its box, never clipped.
    for (const inner of await element.locator(".fit-text__inner").all()) {
      const fitted = await inner.boundingBox();
      expect(fitted, `${id} text box`).not.toBeNull();
      if (!fitted) return;
      expect(fitted.x, `${id} text left`).toBeGreaterThanOrEqual(box.x - 1);
      expect(fitted.y, `${id} text top`).toBeGreaterThanOrEqual(box.y - 1);
      expect(fitted.x + fitted.width, `${id} text right`).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(fitted.y + fitted.height, `${id} text bottom`).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    boxes[id] = box;
  }
  const apart = ["band-red", "band-blue", "clock", "period", "driver-change", "paused", "bottom-bar"].filter((id) => boxes[id]);
  for (let i = 0; i < apart.length; i += 1) {
    for (let j = i + 1; j < apart.length; j += 1) {
      expect(intersects(boxes[apart[i]], boxes[apart[j]]), `${apart[i]} overlaps ${apart[j]}`).toBe(false);
    }
  }
}

/** With TV_SHOTS_DIR set, saves a screenshot there for a by-eye check against the mockups. */
async function shot(page: Page, name: string) {
  const dir = process.env.TV_SHOTS_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

test.describe.serial("TV screens", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let tabletToken = "";
  let saturday = 0;
  let fieldOne = 0;
  let fieldTwo = 0;
  let mainFields = 0;
  let fieldGroup = 0;
  let audienceGroup = 0;
  const teams: number[] = [];
  const matches: Record<string, MatchInfo> = {};
  const devices: Record<string, number> = {};
  const screens: Record<string, Page> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const admin = () => ({ Authorization: `Bearer ${token}` });

  async function call(
    request: APIRequestContext,
    method: "get" | "post" | "put" | "patch",
    route: string,
    data?: unknown,
    headers: Record<string, string> = admin()
  ) {
    const response = await request[method](api(route), { headers, data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  /** A display paired through the pairing screen. `fakeClock` installs Playwright's
   * clock before the app loads, so a test can move the TV's time forward. */
  async function pairDisplay(
    browser: Browser,
    request: APIRequestContext,
    name: string,
    viewport: { width: number; height: number },
    fakeClock = false
  ) {
    const page = await (await browser.newContext({ viewport })).newPage();
    if (fakeClock) await page.clock.install();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    devices[name] = paired.id;
    screens[name] = page;
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    return page;
  }

  /** A scorer tablet paired through the API, for sending live draft totals. */
  async function pairTablet(request: APIRequestContext, name: string): Promise<string> {
    const opened = await (await request.post(api("/api/pairing"))).json();
    await call(request, "post", "/api/devices/pair", { code: opened.code, role: "scorer", name });
    const polled = await (
      await request.get(api(`/api/pairing/${opened.id}`), { headers: { "X-Pairing-Key": opened.poll_key } })
    ).json();
    expect(polled.status).toBe("paired");
    const signedIn = await (await request.post(api("/api/auth/device"), { data: { device_token: polled.device_token } })).json();
    return signedIn.access_token;
  }

  async function assign(request: APIRequestContext, name: string, groupId: number) {
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: devices[name], group_id: groupId });
  }

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8173, frontendPort: 5234, devicePort: 5235 });
    expect((await request.post(api("/api/event"), { data: { name: "TV League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: admin(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildExampleGamePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "example-game" });
    expect(TEAMS[0][1]).toHaveLength(40);
    for (const [number, name] of TEAMS) {
      teams.push((await call(request, "post", "/api/teams", { number, name })).id);
    }
    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    mainFields = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 1" })).id;
    fieldTwo = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 2" })).id;
    const start = Date.now() + 10 * 60_000;
    const plan: [string, number, number, number[], number[]][] = [
      ["Q1", 1, fieldOne, [0, 1], [2, 3]],
      ["Q2", 2, fieldTwo, [4, 5], [0, 2]],
      ["Q3", 3, fieldOne, [1, 3], [4, 5]],
      ["Q4", 4, fieldTwo, [2, 4], [1, 5]],
    ];
    for (const [label, number, field, red, blue] of plan) {
      matches[label] = await call(request, "post", "/api/matches", {
        session_id: saturday,
        round_type: "qualification",
        match_number: number,
        field_id: field,
        scheduled_time: new Date(start + number * 5 * 60_000).toISOString(),
        alliances: [
          { station: "red", team_ids: red.map((i) => teams[i]) },
          { station: "blue", team_ids: blue.map((i) => teams[i]) },
        ],
      });
    }

    tabletToken = await pairTablet(request, "Tablet 1");
    await pairDisplay(browser, request, "Field TV", { width: 1920, height: 1080 });
    await pairDisplay(browser, request, "Big TV", { width: 1280, height: 720 });
    await pairDisplay(browser, request, "Small Field TV", { width: 1280, height: 720 });
    await pairDisplay(browser, request, "Clock TV", { width: 1920, height: 1080 }, true);
    const groups = (await call(request, "get", `/api/displays?session_id=${saturday}`)).groups as {
      id: number;
      kind: string;
      field_set_id: number | null;
      field_id: number | null;
    }[];
    const audience = groups.find((group) => group.kind === "audience" && group.field_set_id === mainFields)!;
    audienceGroup = audience.id;
    fieldGroup = groups.find((group) => group.kind === "field" && group.field_id === fieldOne)!.id;
    await assign(request, "Big TV", audience.id);
    await assign(request, "Field TV", fieldGroup);
    await assign(request, "Clock TV", fieldGroup);
    await assign(request, "Small Field TV", fieldGroup);
  });

  test.afterAll(() => server?.stop());

  const bandNumbers = (match: MatchInfo) => match.alliances.flatMap((a) => a.team_ids).map((id) => `band-number-${id}`);

  test("before the match, red fills the top half and blue the bottom half at 1920×1080 and 1280×720", async () => {
    for (const [name, shotName] of [["Field TV", "field-next-1920x1080"], ["Small Field TV", "field-next-1280x720"]]) {
      const page = screens[name];
      await expect(page.getByTestId("start")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("bottom-bar")).toContainText("Qualification 1");
      await expect(page.getByTestId("bottom-bar")).toContainText("Field 1");
      await expect(page.getByTestId("band-red")).toContainText("83897A");
      await expect(page.getByTestId("band-red")).toContainText("10480B");
      await expect(page.getByTestId("band-blue")).toContainText("19533Z");
      await expect(page.getByTestId("band-blue")).toContainText("94927X");
      await expectFits(page, ["band-red", "band-blue", "bottom-bar", ...bandNumbers(matches.Q1)]);
      const red = await page.getByTestId("band-red").boundingBox();
      const blue = await page.getByTestId("band-blue").boundingBox();
      const bar = await page.getByTestId("bottom-bar").boundingBox();
      expect(red && blue && bar).toBeTruthy();
      if (!red || !blue || !bar) return;
      // The two bands split the area above the bar in half.
      expect(red.y).toBeLessThanOrEqual(1);
      expect(Math.abs(red.height - blue.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(red.y + red.height - blue.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(blue.y + blue.height - bar.y)).toBeLessThanOrEqual(2);
      await shot(page, shotName);
    }
  });

  test("starting a match fills the screen with the count-in, then the clock fits at 1920×1080 and 1280×720", async ({ request }) => {
    const fieldTv = screens["Field TV"];
    const bigTv = screens["Big TV"];
    // The field TV is on its next-match screen, counting down to Q1.
    await expect(fieldTv.getByTestId("start")).toBeVisible({ timeout: 10_000 });
    await expect(fieldTv.getByTestId("bottom-bar")).toContainText("Qualification 1");
    await call(request, "post", `/api/matches/${matches.Q1.id}/start`, {});

    // Both overlays are read at once, right after they appear: the count-in lasts only 3 s.
    const pages = [fieldTv, bigTv];
    await Promise.all(
      pages.map(async (page) => {
        await expect(page.getByTestId("count-in")).toBeVisible({ timeout: 3_000 });
        await expect(page.getByTestId("count-in")).toHaveText(/^[123]$/);
      })
    );
    const overlayBoxes = await Promise.all(pages.map((page) => page.getByTestId("count-in").boundingBox()));
    pages.forEach((page, i) => {
      const box = overlayBoxes[i];
      expect(box, "count-in box").not.toBeNull();
      const viewport = page.viewportSize()!;
      expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    });

    // Live totals from a scorer tablet show in the bottom bar while the clock runs.
    const red = matches.Q1.alliances.find((a) => a.station === "red")!;
    const blue = matches.Q1.alliances.find((a) => a.station === "blue")!;
    await call(request, "patch", `/api/matches/${matches.Q1.id}/alliances/${red.id}/draft`, { changes: { high_balls: 16 } }, { Authorization: `Bearer ${tabletToken}` });
    await call(request, "patch", `/api/matches/${matches.Q1.id}/alliances/${blue.id}/draft`, { changes: { high_balls: 17, low_balls: 1 } }, { Authorization: `Bearer ${tabletToken}` });

    for (const page of [fieldTv, bigTv]) {
      await expect(page.getByTestId("clock")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("count-in")).toHaveCount(0);
      await expect(page.getByTestId("period")).toHaveText("Autonomous");
      await expect(page.getByTestId("band-red")).toContainText("83897A");
      await expect(page.getByTestId("band-red")).toContainText("10480B");
      await expect(page.getByTestId("band-blue")).toContainText("19533Z");
      await expect(page.getByTestId("band-blue")).toContainText("94927X");
      await expect(page.getByTestId("live-red")).toContainText("48", { timeout: 10_000 });
      await expect(page.getByTestId("live-blue")).toContainText("52");
      await expect(page.getByTestId("bottom-bar")).toContainText("Field 1");
      await expectFits(page, ["band-red", "band-blue", "clock", "period", "bottom-bar", "live-red", "live-blue", ...bandNumbers(matches.Q1)]);
    }
  });

  test("the driver-change tag shows from 35 s down to 25 s left in the driver period", async ({ request }) => {
    const fieldTv = screens["Field TV"];
    const clockTv = screens["Clock TV"];
    // Autonomous runs 15 s on the server's own timer; then the driver period is started.
    await expect(fieldTv.getByText("Driver control next")).toBeVisible({ timeout: 25_000 });
    await expectFits(fieldTv, ["band-red", "band-blue", "bottom-bar"]);
    await call(request, "post", `/api/matches/${matches.Q1.id}/start-driver`, {});
    await expect(fieldTv.getByTestId("period")).toHaveText("Driver control", { timeout: 10_000 });
    await expect(clockTv.getByTestId("period")).toHaveText("Driver control", { timeout: 10_000 });

    // The driver period is 105 s. Rather than wait 70 s, move only the Clock TV's
    // own time forward to 30 s before the server's deadline. The TV measured its
    // offset from the server before the jump, so it now reads 0:30 left.
    // Wait out the 3 s count-in, so the deadline read is the driver period's own.
    type Row = { id: number; phase: string; phase_deadline: string };
    const q1 = async () => ((await call(request, "get", `/api/matches?session_id=${saturday}`)) as Row[]).find((m) => m.id === matches.Q1.id)!;
    await expect.poll(async () => (await q1()).phase, { timeout: 10_000 }).toBe("driver");
    const deadline = Date.parse((await q1()).phase_deadline);
    const pageNow = await clockTv.evaluate(() => Date.now());
    await clockTv.clock.fastForward(deadline - 30_000 - pageNow);
    const tag = clockTv.getByTestId("driver-change");
    await expect(tag).toHaveText("Driver change");
    await expect(clockTv.getByTestId("period")).toHaveCount(0);
    await expect(clockTv.getByTestId("clock")).toHaveText(/^0:(2[6-9]|3[0-5])$/);
    await expectFits(clockTv, ["band-red", "band-blue", "clock", "driver-change", "bottom-bar"]);
    await shot(clockTv, "in-match-1920x1080-driver-change");
    // The other TVs, on real time, still show the period name.
    await expect(fieldTv.getByTestId("period")).toHaveText("Driver control");
    await shot(fieldTv, "in-match-1920x1080");
    await shot(screens["Big TV"], "in-match-1280x720");

    await clockTv.clock.fastForward(6_000);
    await expect(clockTv.getByTestId("period")).toHaveText("Driver control");
    await expect(tag).toHaveCount(0);

    // Paused: the paused tag replaces the period name and stays clear of the clock.
    await call(request, "post", `/api/matches/${matches.Q1.id}/pause`, {});
    await expect(fieldTv.getByTestId("paused")).toBeVisible({ timeout: 10_000 });
    await expect(fieldTv.getByTestId("period")).toHaveCount(0);
    await expectFits(fieldTv, ["band-red", "band-blue", "clock", "paused", "bottom-bar"]);
    await call(request, "post", `/api/matches/${matches.Q1.id}/resume`, {});
    await expect(fieldTv.getByTestId("paused")).toHaveCount(0, { timeout: 10_000 });

    await call(request, "post", `/api/matches/${matches.Q1.id}/end`, {});
    // The Clock TV's own time was moved forward; start it afresh so later tests are not skewed.
    await clockTv.reload();
    await expect(fieldTv.getByText("Match over")).toBeVisible({ timeout: 10_000 });
    await expect(fieldTv.getByTestId("clock")).toHaveText("0:00");
    await expect(fieldTv.getByTestId("live-red")).toHaveCount(0);
  });
  test("the match intro lists one row per team by side and keeps a six-character number whole at 1920×1080 and 1280×720", async ({ browser, request }) => {
    // Save Q1 as 48 to 52 so the audience screen's next match is Q2, where the long-named team is on blue.
    const red = matches.Q1.alliances.find((a) => a.station === "red")!;
    const blue = matches.Q1.alliances.find((a) => a.station === "blue")!;
    await call(request, "post", `/api/matches/${matches.Q1.id}/alliances/${red.id}/score`, { data: { high_balls: 16, auto_winner: "tie" } });
    await call(request, "post", `/api/matches/${matches.Q1.id}/alliances/${blue.id}/score`, { data: { high_balls: 17, low_balls: 1, auto_winner: "tie" } });
    await call(request, "patch", `/api/displays/groups/${audienceGroup}`, { screen: "match_intro" });
    const wide = await pairDisplay(browser, request, "Audience TV", { width: 1920, height: 1080 });
    await assign(request, "Audience TV", audienceGroup);

    const longTeam = teams[0];
    for (const [page, shotName] of [[wide, "intro-1920x1080"], [screens["Big TV"], "intro-1280x720"]] as [Page, string][]) {
      await expect(page.getByTestId("intro-red")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("bottom-bar")).toContainText("Up next · Qualification 2");
      await expect(page.getByTestId("bottom-bar")).toContainText("Field 2");
      await expect(page.getByTestId("start")).toBeVisible();
      await expect(page.getByTestId("intro-red")).toContainText("55210C");
      await expect(page.getByTestId("intro-red")).toContainText("31415P");
      await expect(page.getByTestId("intro-blue")).toContainText("83897A");
      await expect(page.getByTestId("intro-blue")).toContainText("19533Z");
      await expect(page.getByTestId(`rank-${longTeam}`)).toBeVisible();
      // The number is whole even though the team's name is 40 characters.
      expect(await page.getByTestId(`intro-number-${longTeam}`).textContent()).toBe("83897A");
      const rows = [teams[4], teams[5], teams[0], teams[2]];
      await expectFits(page, ["intro-red", "intro-blue", "bottom-bar", ...rows.map((id) => `intro-number-${id}`)]);
      await shot(page, shotName);
    }
  });

  test("the last result shows red and blue scores, tags the winner and has no breakdown at 1920×1080 and 1280×720", async ({ request }) => {
    await call(request, "patch", `/api/displays/groups/${audienceGroup}`, { screen: "last_scored_match" });
    for (const [name, shotName] of [["Audience TV", "result-1920x1080"], ["Big TV", "result-1280x720"]]) {
      const page = screens[name];
      await expect(page.getByTestId("result-blue")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("bottom-bar")).toContainText("Result · Qualification 1");
      await expect(page.getByTestId("score-red")).toHaveText("48");
      await expect(page.getByTestId("score-blue")).toHaveText("52");
      await expect(page.getByTestId("result-blue").getByTestId("winner")).toHaveText("Winner");
      await expect(page.getByTestId("result-red").getByTestId("winner")).toHaveCount(0);
      await expect(page.getByTestId("result-red")).toHaveClass(/is-loser/);
      await expect(page.getByTestId("result-blue")).not.toHaveClass(/is-loser/);
      await expect(page.getByTestId("result-red")).toContainText("83897A");
      await expect(page.getByTestId("result-blue")).toContainText("94927X");
      await expect(page.getByRole("table")).toHaveCount(0);
      const numbers = matches.Q1.alliances.flatMap((a) => a.team_ids).map((id) => `result-number-${id}`);
      await expectFits(page, ["result-red", "result-blue", "score-red", "score-blue", "bottom-bar", ...numbers]);
      await shot(page, shotName);
    }
  });

  const fontSize = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  test("teamwork rankings are one full-width table, larger at the audience TV than at a pit TV, at 1920×1080", async ({ browser, request }) => {
    await call(request, "patch", `/api/displays/groups/${audienceGroup}`, { screen: "teamwork_rankings" });
    const pit = await call(request, "post", "/api/displays/pit-groups", { session_id: saturday, name: "Pit Rankings" });
    await call(request, "patch", `/api/displays/groups/${pit.id}`, { screen: "teamwork_rankings" });
    const pitTv = await pairDisplay(browser, request, "Pit TV", { width: 1920, height: 1080 });
    await assign(request, "Pit TV", pit.id);

    const audienceTv = screens["Audience TV"];
    for (const [page, size, shotName] of [
      [audienceTv, "audience", "rankings-audience-1920x1080"],
      [pitTv, "pit", "rankings-pit-1920x1080"],
    ] as [Page, string, string][]) {
      const table = page.getByRole("table", { name: "Teamwork Rankings" });
      await expect(table).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`.table-screen--${size}`)).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Rankings", exact: true })).toBeVisible();
      await expect(page.getByText("After 1 of 4 qualification matches")).toBeVisible();
      await expect(page.getByRole("complementary")).toHaveCount(0);
      await expect(page.getByText("Match schedule & results")).toHaveCount(0);
      await expect(table.getByRole("row").nth(0)).toContainText(/Rank.*Team.*Name.*W-L-T.*WP.*SoS/);
      // Q1 was 48 to 52: the blue teams won.
      await expect(page.getByTestId(`rank-row-${teams[2]}`)).toContainText(/19533Z.*Charlie.*1-0-0/);
      await expect(page.getByTestId(`rank-row-${teams[0]}`)).toContainText(/83897A.*0-1-0/);
      const wide = await table.boundingBox();
      expect(wide!.width).toBeGreaterThan(1920 * 0.85);
      await shot(page, shotName);
    }
    const audienceFont = await fontSize(audienceTv, ".rank-table tbody td");
    const pitFont = await fontSize(pitTv, ".rank-table tbody td");
    expect(audienceFont).toBeGreaterThan(pitFont);
    // The amber top three: exactly three rank cells are marked.
    await expect(audienceTv.locator(".rank-table__rank.is-top")).toHaveCount(3);
  });

  test("the schedule on a pit TV has red and blue columns, an on-field tag per field and whole team numbers, at 1920×1080", async ({ request }) => {
    const pitTv = screens["Pit TV"];
    const pit = (await call(request, "get", `/api/displays?session_id=${saturday}`)).groups.find((g: { name: string }) => g.name === "Pit Rankings");
    await call(request, "patch", `/api/displays/groups/${pit.id}`, { screen: "schedule" });
    const table = pitTv.getByRole("table", { name: "Match Schedule" });
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(pitTv.locator(".table-screen--pit")).toHaveCount(1);
    await expect(pitTv.getByRole("heading", { name: "Match Schedule" })).toBeVisible();
    await expect(pitTv.getByText("Qualification · 1 of 4 played")).toBeVisible();
    await expect(table.getByRole("row").nth(0)).toContainText(/Match.*Time.*Field.*Red.*Blue/);
    // Q1 is played; Q2 (field 2) and Q3 (field 1) are each field's next match.
    await expect(pitTv.getByTestId("on-field")).toHaveCount(2);
    await expect(table.getByRole("row", { name: /Q2/ }).getByTestId("on-field")).toHaveText("On field");
    await expect(table.getByRole("row", { name: /Q3/ }).getByTestId("on-field")).toHaveText("On field");
    await expect(table.getByRole("row", { name: /Q1/ })).toHaveClass(/is-done/);
    // Q2 sits in an even row, where the zebra rule once hid the highlight: check the painted colour.
    const background = (name: RegExp) => table.getByRole("row", { name }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await background(/Q2/)).toBe("rgba(227, 178, 26, 0.14)");
    expect(await background(/Q3/)).toBe("rgba(227, 178, 26, 0.14)");
    expect(await background(/Q4/)).not.toBe("rgba(227, 178, 26, 0.14)");
    await expect(table.getByRole("row", { name: /Q2/ })).toHaveClass(/is-on-field/);
    // Q1: red 83897A and 10480B, blue 19533Z and 94927X, in their own columns.
    const q1 = table.getByRole("row", { name: /Q1/ });
    await expect(q1.locator(".schedule-table__side--red")).toContainText("83897A");
    await expect(q1.locator(".schedule-table__side--blue")).toContainText("19533Z");
    const widths = await table.locator(".team-numbers").evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth));
    expect(Math.max(...widths)).toBeLessThanOrEqual(1);
    const wide = await table.boundingBox();
    expect(wide!.width).toBeGreaterThan(1920 * 0.85);
    await shot(pitTv, "schedule-pit-1920x1080");
  });
});

test.describe.serial("TV skills rankings", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let session = 0;
  const teams: Record<string, number> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const admin = () => ({ Authorization: `Bearer ${token}` });

  async function call(request: APIRequestContext, method: "get" | "post" | "put" | "patch", route: string, data?: unknown) {
    const response = await request[method](api(route), { headers: admin(), data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  async function pair(browser: Browser, request: APIRequestContext, name: string, groupId: number) {
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await call(request, "put", "/api/displays/assignments", { session_id: session, device_id: paired.id, group_id: groupId });
    return page;
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8174, frontendPort: 5236, devicePort: 5237 });
    expect((await request.post(api("/api/event"), { data: { name: "Skills TV League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: admin(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "sample_cooperative" });
    for (const [number, name] of [["S1", "Skills One"], ["S2", "Skills Two"], ["S3", "Skills Three"], ["S4", "Skills Four"]]) {
      teams[number] = (await call(request, "post", "/api/teams", { number, name })).id;
    }
    session = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: session });
    await call(request, "post", "/api/field-sets", { session_id: session, name: "Main Fields" });
    await call(request, "put", "/api/skills/settings", { enabled: true, attempts: { autonomous: 3, driver: 3 } });
    for (const number of ["S1", "S2", "S3"]) {
      await call(request, "post", `/api/sessions/${session}/participants`, { team_id: teams[number], checked_in: true });
    }
    const attempts: [string, string, number][] = [
      ["S1", "autonomous", 40], ["S1", "autonomous", 90], ["S1", "driver", 107],
      ["S2", "autonomous", 60], ["S2", "driver", 30], ["S2", "driver", 55],
      ["S3", "autonomous", 20],
    ];
    for (const [team, type, score] of attempts) {
      await call(request, "post", `/api/sessions/${session}/skills/attempts`, { team_id: teams[team], skills_type: type, data: { score } });
    }
  });

  test.afterAll(() => server?.stop());

  test("skills rankings show total, best and attempts used per type, with no side panels, at 1920×1080", async ({ browser, request }) => {
    const groups = (await call(request, "get", `/api/displays?session_id=${session}`)).groups as { id: number; kind: string }[];
    const audience = groups.find((group) => group.kind === "audience")!;
    await call(request, "patch", `/api/displays/groups/${audience.id}`, { screen: "skills_rankings" });
    const pit = await call(request, "post", "/api/displays/pit-groups", { session_id: session, name: "Pit Skills" });
    await call(request, "patch", `/api/displays/groups/${pit.id}`, { screen: "skills_rankings" });
    const audienceTv = await pair(browser, request, "Audience Skills TV", audience.id);
    const pitTv = await pair(browser, request, "Pit Skills TV", pit.id);
    for (const [page, size, shotName] of [
      [audienceTv, "audience", "skills-rankings-audience-1920x1080"],
      [pitTv, "pit", "skills-rankings-pit-1920x1080"],
    ] as [Page, string, string][]) {
      const table = page.getByRole("table", { name: "Skills Rankings" });
      await expect(table).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`.table-screen--${size}`)).toHaveCount(1);
      await expect(page.getByRole("complementary")).toHaveCount(0);
      await expect(page.getByText("Top 10")).toHaveCount(0);
      await expect(page.getByText("Recent scores")).toHaveCount(0);
      await expect(table.getByRole("row").nth(0)).toContainText(/Rank.*Team.*Name.*Total.*Autonomous.*Driver/);
      // S1: best autonomous 90 over 2 of 3 attempts, driver 107 over 1 of 3.
      await expect(page.getByTestId(`rank-row-${teams.S1}`)).toContainText(/S1.*Skills One.*197.*90.*2\/3.*107.*1\/3/);
      // S3 never drove: a dash and 0/3.
      await expect(page.getByTestId(`rank-row-${teams.S3}`)).toContainText(/S3.*20.*20.*1\/3.*–.*0\/3/);
      await shot(page, shotName);
    }
  });
});
