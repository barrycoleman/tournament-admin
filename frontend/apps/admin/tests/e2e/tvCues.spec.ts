import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { buildCueGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";
import { makeWav } from "./fixtures/wav";

const PASSWORD = "tv-cues-e2e-pw";
const SHOTS_DIR = process.env.TV_CUES_SHOTS_DIR;

// The flash colours, from the TV's stylesheet tokens.
const AMBER = "rgb(227, 178, 26)"; // --kiosk-soon
const WHITE = "rgb(246, 243, 236)"; // --kiosk-ink
const RED = "rgb(210, 60, 44)"; // --kiosk-late

interface Flash {
  kind: string;
  text: string;
  top: boolean;
  background: string;
}

/**
 * Runs in every page before its app: headless Chrome has no audio output, so
 * AudioContext is replaced by a stand-in that is always "running" and decodes
 * anything; every cue the SoundPlayer is asked to play is collected from its
 * `tv-cue` window event into `__cues`; and every flash and window tag that
 * appears is noted into `__flashes` / `__tags`, so a 2 s banner is never missed.
 */
function watchCues() {
  const w = window as unknown as {
    __cues: string[];
    __flashes: Flash[];
    __tags: string[];
    AudioContext: unknown;
    webkitAudioContext: unknown;
  };
  w.__cues = [];
  w.__flashes = [];
  w.__tags = [];
  window.addEventListener("tv-cue", (event) => w.__cues.push((event as CustomEvent<{ slot: string }>).detail.slot));
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    decodeAudioData() {
      return Promise.resolve({ duration: 0.5 });
    }
    createBufferSource() {
      return { buffer: null, onended: null, connect() {}, start() {}, stop() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  w.AudioContext = FakeAudioContext;
  w.webkitAudioContext = FakeAudioContext;
  const seen = new WeakSet<Element>();
  let lastTag: string | null = null;
  const scan = () => {
    document.querySelectorAll('[data-testid="cue-flash"]').forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const banner = el.querySelector<HTMLElement>(".cue-flash__banner");
      w.__flashes.push({
        kind: el.getAttribute("data-kind") ?? "",
        text: banner?.innerText.trim() ?? "",
        top: el.classList.contains("cue-flash--top"),
        background: banner ? getComputedStyle(banner).backgroundColor : "",
      });
    });
    const tag = document.querySelector<HTMLElement>('[data-testid="window-tag"]');
    const text = tag ? tag.innerText.trim() : null;
    if (text !== lastTag) {
      if (text) w.__tags.push(text);
      lastTag = text;
    }
  };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true });
}

const cuesOf = (page: Page) => page.evaluate(() => (window as unknown as { __cues: string[] }).__cues.slice());
const flashesOf = (page: Page) => page.evaluate(() => (window as unknown as { __flashes: Flash[] }).__flashes.slice());
const tagsOf = (page: Page) => page.evaluate(() => (window as unknown as { __tags: string[] }).__tags.slice());
const clearSeen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __cues: string[]; __flashes: Flash[]; __tags: string[] };
    w.__cues.length = 0;
    w.__flashes.length = 0;
    w.__tags.length = 0;
  });

/** Switches the device app's i18next to another language: the TV has no
 * language setting, so this reaches the one i18next instance Vite serves it. */
async function useLanguage(page: Page, lng: string) {
  await page.evaluate(async (language) => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/deps\/i18next\.js/.test(name));
    if (!url) throw new Error("i18next module not found");
    const i18next = (await import(/* @vite-ignore */ url)).default as { changeLanguage: (l: string) => Promise<unknown> };
    await i18next.changeLanguage(language);
  }, lng);
}

/** The flash banner's box, its text's box, and the boxes of what it must never cover,
 * read in one go. The live totals sit inside the bottom bar the banner covers, so
 * for them it is enough that they paint above the banner and its text keeps clear. */
async function flashBoxes(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const covered: Record<string, ReturnType<typeof rect>> = {};
    for (const id of ["clock", "band-red", "band-blue", "period", "window-tag", "paused"]) {
      covered[id] = rect(document.querySelector(`[data-testid="${id}"]`));
    }
    const totals: Record<string, { box: ReturnType<typeof rect>; onTop: boolean }> = {};
    for (const id of ["live-red", "live-blue", "live-combined"]) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const box = rect(el);
      if (!el || !box || box.width === 0) continue;
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      totals[id] = { box, onTop: !!hit && el.contains(hit) };
    }
    return {
      banner: rect(document.querySelector(".cue-flash__banner")),
      text: rect(document.querySelector(".cue-flash__text .fit-line__inner") ?? document.querySelector(".cue-flash__text")),
      covered,
      totals,
    };
  });
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

function expectNoOverlap(boxes: Awaited<ReturnType<typeof flashBoxes>>, where: string) {
  const { banner, text } = boxes;
  expect(banner, `${where} banner`).not.toBeNull();
  expect(text, `${where} banner text`).not.toBeNull();
  if (!banner || !text) return;
  // The banner's text is centred between the two totals.
  expect(Math.abs(text.x + text.width / 2 - (banner.x + banner.width / 2)), `${where}: banner text centred`).toBeLessThan(4);
  expect(boxes.covered.clock, `${where} clock`).not.toBeNull();
  for (const [id, b] of Object.entries(boxes.covered)) {
    if (!b || b.width === 0 || b.height === 0) continue;
    expect(overlaps(banner, b), `${where}: banner overlaps ${id}`).toBe(false);
  }
  for (const [id, { box, onTop }] of Object.entries(boxes.totals)) {
    expect(onTop, `${where}: ${id} is painted over`).toBe(true);
    expect(overlaps(text, box!), `${where}: banner text overlaps ${id}`).toBe(false);
  }
}

async function saveShot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/${name}.png` });
}

test.describe.serial("TV cues", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let mainFields = 0;
  let fieldOne = 0;
  let skillsRow = 0;
  let skillsOne = 0;
  let audienceGroup = 0;
  const teams: number[] = [];
  const matches: number[] = [];
  const alliances: Record<number, number[]> = {};
  const devices: Record<string, number> = {};
  const screens: Record<string, Page> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const admin = () => ({ Authorization: `Bearer ${token}` });

  async function call(request: APIRequestContext, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown) {
    const response = await request[method](api(route), { headers: admin(), data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  async function pairDisplay(browser: Browser, request: APIRequestContext, name: string, viewport: { width: number; height: number }) {
    const context: BrowserContext = await browser.newContext({ viewport });
    await context.addInitScript(watchCues);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    devices[name] = paired.id;
    screens[name] = page;
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    return page;
  }

  async function adminPage(browser: Browser, path: string): Promise<Page> {
    const context = await browser.newContext();
    await context.addInitScript(watchCues);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    return page;
  }

  const phaseOf = async (request: APIRequestContext, id: number) =>
    ((await call(request, "get", `/api/matches?session_id=${saturday}`)) as { id: number; phase: string }[]).find((m) => m.id === id)!.phase;

  async function waitPhase(request: APIRequestContext, id: number, phase: string, timeout = 20_000) {
    await expect.poll(() => phaseOf(request, id), { timeout, intervals: [200] }).toBe(phase);
  }

  /** Starts a match and waits until autonomous is over and driver control is waiting. */
  async function runAutonomous(request: APIRequestContext, id: number) {
    await call(request, "post", `/api/matches/${id}/start`, {});
    await waitPhase(request, id, "awaiting_driver");
  }

  /** The TV page has loaded TvSounds (it preloads every slot once mounted). */
  async function soundsMounted(page: Page, action: () => Promise<unknown>) {
    const loaded = page.waitForRequest((req) => req.url().includes("/api/sounds/beep/audio"), { timeout: 15_000 });
    await action();
    await loaded;
  }

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8203, frontendPort: 5264, devicePort: 5265 });
    expect((await request.post(api("/api/event"), { data: { name: "Cue League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: admin(),
      multipart: { file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildCueGamePluginZip()) } },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "cue-game" });
    await call(request, "put", "/api/skills/settings", { enabled: true, attempts: {} });
    for (const [number, name] of [["11A", "Alpha"], ["22B", "Bravo"], ["33C", "Charlie"], ["44D", "Delta"]]) {
      teams.push((await call(request, "post", "/api/teams", { number, name })).id);
    }
    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    for (const teamId of teams) await call(request, "post", `/api/sessions/${saturday}/participants`, { team_id: teamId, checked_in: true });
    mainFields = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 1" })).id;
    skillsRow = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Skills Row", purpose: "skills" })).id;
    skillsOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: skillsRow, name: "Skills 1" })).id;
    const start = Date.now() + 10 * 60_000;
    for (let number = 1; number <= 8; number += 1) {
      const match = await call(request, "post", "/api/matches", {
        session_id: saturday,
        round_type: "qualification",
        match_number: number,
        field_id: fieldOne,
        scheduled_time: new Date(start + number * 5 * 60_000).toISOString(),
        alliances: [
          { station: "red", team_ids: [teams[0], teams[1]] },
          { station: "blue", team_ids: [teams[2], teams[3]] },
        ],
      });
      matches.push(match.id);
      alliances[match.id] = (match.alliances as { id: number }[]).map((a) => a.id);
    }

    await pairDisplay(browser, request, "Audience TV", { width: 1280, height: 720 });
    await pairDisplay(browser, request, "Field TV", { width: 1920, height: 1080 });
    await pairDisplay(browser, request, "Skills TV", { width: 1280, height: 720 });
    await pairDisplay(browser, request, "Skills Field TV", { width: 1280, height: 720 });
    const groups = (await call(request, "get", `/api/displays?session_id=${saturday}`)).groups as {
      id: number;
      kind: string;
      field_set_id: number | null;
      field_id: number | null;
    }[];
    audienceGroup = groups.find((g) => g.kind === "audience" && g.field_set_id === mainFields)!.id;
    const fieldGroup = groups.find((g) => g.kind === "field" && g.field_id === fieldOne)!.id;
    const skillsAudience = groups.find((g) => g.kind === "audience" && g.field_set_id === skillsRow)!.id;
    const skillsField = groups.find((g) => g.kind === "field" && g.field_id === skillsOne)!.id;
    await call(request, "patch", `/api/displays/groups/${audienceGroup}`, { screen: "in_match" });
    const assign = (name: string, groupId: number) =>
      call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: devices[name], group_id: groupId });
    await assign("Audience TV", audienceGroup);
    await assign("Field TV", fieldGroup);
    await assign("Skills TV", skillsAudience);
    await assign("Skills Field TV", skillsField);
    // Sound on for the two audience TVs; the field TVs start with it off.
    await soundsMounted(screens["Audience TV"], () => call(request, "patch", `/api/devices/${devices["Audience TV"]}`, { play_sounds: true }));
    await soundsMounted(screens["Skills TV"], () => call(request, "patch", `/api/devices/${devices["Skills TV"]}`, { play_sounds: true }));
    await expect(screens["Field TV"].getByTestId("start")).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(() => server?.stop());

  test("a full match cues every moment in order on a TV with sound on, and flashes on both TVs; a TV with sound off stays quiet", async ({ request }, testInfo) => {
    const audience = screens["Audience TV"];
    const field = screens["Field TV"];
    await clearSeen(audience);
    await clearSeen(field);
    const id = matches[0];
    await runAutonomous(request, id);
    await call(request, "post", `/api/matches/${id}/start-driver`, {});
    await waitPhase(request, id, "driver", 10_000);

    // The driver-change window opens 8 s before the end: amber banner and the window tag,
    // and the banner covers neither the clock, the team bands, the tag nor the totals.
    const flash = (page: Page) => page.locator('[data-testid="cue-flash"][data-kind="moment"]');
    await Promise.all([expect(flash(audience)).toBeVisible({ timeout: 10_000 }), expect(flash(field)).toBeVisible({ timeout: 10_000 })]);
    const [audienceBoxes, fieldBoxes] = await Promise.all([flashBoxes(audience), flashBoxes(field)]);
    expectNoOverlap(audienceBoxes, "1280×720");
    expectNoOverlap(fieldBoxes, "1920×1080");
    await saveShot(field, testInfo, "match-tv-amber-driver-change-1920x1080");

    await waitPhase(request, id, "ended", 20_000);
    const expected = ["beep", "beep", "beep", "start", "beep", "beep", "beep", "beep", "beep", "beep", "start", "moment", "moment", "moment", "beep", "beep", "beep", "buzzer"];
    await expect.poll(() => cuesOf(audience), { timeout: 5_000 }).toEqual(expected);

    for (const page of [audience, field]) {
      await expect.poll(() => flashesOf(page).then((list) => list.map((f) => `${f.kind}:${f.text}`)), { timeout: 5_000 }).toEqual([
        "moment:DRIVER CHANGE",
        "moment:DRIVER CHANGE",
        "moment:ENDGAME",
        "over:MATCH OVER",
      ]);
      const flashes = await flashesOf(page);
      expect(flashes.map((f) => f.background)).toEqual([AMBER, AMBER, AMBER, WHITE]);
      expect(flashes.every((f) => !f.top)).toBe(true);
      expect(await tagsOf(page)).toContain("DRIVER CHANGE");
    }
    expect(await cuesOf(field)).toEqual([]);
  });

  test("ending early in driver control plays the power-down and a red MATCH STOPPED, never the buzzer, and the field TV's switch turned on makes it cue", async ({ request }, testInfo) => {
    const audience = screens["Audience TV"];
    const field = screens["Field TV"];
    await soundsMounted(field, () => call(request, "patch", `/api/devices/${devices["Field TV"]}`, { play_sounds: true }));
    await clearSeen(audience);
    await clearSeen(field);
    const id = matches[1];
    await runAutonomous(request, id);
    await call(request, "post", `/api/matches/${id}/start-driver`, {});
    await waitPhase(request, id, "driver", 10_000);
    // Well before the driver change at 8 s left.
    await call(request, "post", `/api/matches/${id}/end`, {});
    const red = field.locator('[data-testid="cue-flash"][data-kind="stop"]');
    await expect(red).toBeVisible({ timeout: 5_000 });
    await expect(red.locator(".cue-flash__banner")).toHaveText(/match stopped/i);
    await saveShot(field, testInfo, "match-tv-red-match-stopped-1920x1080");

    for (const page of [audience, field]) {
      await expect.poll(() => cuesOf(page).then((c) => c.at(-1)), { timeout: 5_000 }).toBe("stop");
      const cues = await cuesOf(page);
      expect(cues).not.toContain("buzzer");
      expect(cues).toContain("start");
      const flashes = await flashesOf(page);
      expect(flashes.map((f) => `${f.kind}:${f.text}`)).toEqual(["stop:MATCH STOPPED"]);
      expect(flashes[0].background).toBe(RED);
    }
  });

  test("a full reset during autonomous plays the power-down with a red flash, then the TV goes back to its pre-match view", async ({ request }) => {
    const audience = screens["Audience TV"];
    const field = screens["Field TV"];
    await clearSeen(audience);
    await clearSeen(field);
    // Score the two played matches, so the field TV's next match is the one reset below.
    for (const played of matches.slice(0, 2)) {
      for (const alliance of alliances[played]) {
        await call(request, "post", `/api/matches/${played}/alliances/${alliance}/score`, { data: { high_balls: 1, auto_winner: "tie" } });
      }
    }
    const id = matches[2];
    await expect(field.getByTestId("start")).toBeVisible({ timeout: 10_000 });
    await expect(field.getByTestId("bottom-bar")).toContainText("Qualification 3");
    await clearSeen(audience);
    await clearSeen(field);
    await call(request, "post", `/api/matches/${id}/start`, {});
    await waitPhase(request, id, "autonomous", 10_000);
    await expect(field.getByTestId("clock")).toBeVisible({ timeout: 5_000 });
    await call(request, "post", `/api/matches/${id}/reset`, { scope: "full" });
    await expect(field.locator('[data-testid="cue-flash"][data-kind="stop"]')).toBeVisible({ timeout: 5_000 });
    await expect(field.getByTestId("start")).toBeVisible({ timeout: 10_000 });
    await expect(field.getByTestId("bottom-bar")).toContainText("Qualification 3");
    for (const page of [audience, field]) {
      await expect.poll(() => cuesOf(page).then((c) => c.at(-1)), { timeout: 5_000 }).toBe("stop");
      expect(await cuesOf(page)).not.toContain("buzzer");
      expect((await flashesOf(page)).map((f) => f.kind)).toEqual(["stop"]);
    }
  });

  test("in Chinese the red banner reads 比赛中止", async ({ request }) => {
    const field = screens["Field TV"];
    await useLanguage(field, "zh");
    try {
      const id = matches[2];
      await call(request, "post", `/api/matches/${id}/start`, {});
      await waitPhase(request, id, "autonomous", 10_000);
      await call(request, "post", `/api/matches/${id}/end`, {});
      await expect(field.locator('[data-testid="cue-flash"][data-kind="stop"] .cue-flash__banner')).toHaveText("比赛中止", { timeout: 5_000 });
    } finally {
      await useLanguage(field, "en");
    }
  });

  test("an organiser's upload reaches an open TV without a reload, and the next start still cues", async ({ request }) => {
    const audience = screens["Audience TV"];
    const refetched = audience.waitForRequest((req) => req.url().includes("/api/sounds/start/audio"), { timeout: 15_000 });
    const put = await request.put(api("/api/sounds/start"), {
      headers: admin(),
      multipart: { file: { name: "fanfare.wav", mimeType: "audio/wav", buffer: makeWav() } },
    });
    expect(put.ok(), await put.text()).toBeTruthy();
    const req = await refetched;
    const response = await req.response();
    expect(response?.status()).toBe(200);
    expect((await response!.body()).subarray(0, 4).toString("ascii")).toBe("RIFF");

    await clearSeen(audience);
    const id = matches[3];
    await call(request, "post", `/api/matches/${id}/start`, {});
    await expect.poll(() => cuesOf(audience), { timeout: 10_000 }).toContain("start");
    await call(request, "post", `/api/matches/${id}/end`, {});
    await call(request, "delete", "/api/sounds/start");
  });

  test("Match Control's Play sounds on this computer plays the cues, is remembered after a reload, and is silent when off", async ({ browser, request }) => {
    const page = await adminPage(browser, "/match-control");
    const toggle = page.getByLabel("Play sounds on this computer");
    await expect(toggle).not.toBeChecked();
    // Both TVs on the field set have sound on now.
    await expect(page.getByLabel("TVs play sounds")).toBeChecked();
    await toggle.check();
    await page.waitForTimeout(500);
    await clearSeen(page);
    let id = matches[4];
    await call(request, "post", `/api/matches/${id}/start`, {});
    await expect.poll(() => cuesOf(page), { timeout: 10_000 }).toContain("start");
    await call(request, "post", `/api/matches/${id}/end`, {});
    await expect.poll(() => cuesOf(page).then((c) => c.at(-1)), { timeout: 5_000 }).toBe("stop");
    // No flash on an operator computer.
    expect(await flashesOf(page)).toEqual([]);

    await page.reload();
    await expect(page.getByLabel("Play sounds on this computer")).toBeChecked();
    await page.getByLabel("Play sounds on this computer").uncheck();
    await clearSeen(page);
    id = matches[5];
    await call(request, "post", `/api/matches/${id}/start`, {});
    await waitPhase(request, id, "autonomous", 10_000);
    await call(request, "post", `/api/matches/${id}/end`, {});
    await page.waitForTimeout(1_000);
    expect(await cuesOf(page)).toEqual([]);
    await page.context().close();
  });

  test("a skills set cues a start, a run-out with TIME, an early end with STOPPED, and nothing for a reset of an ended timer", async ({ request }, testInfo) => {
    const skills = screens["Skills TV"];
    const fieldTv = screens["Skills Field TV"];
    await call(request, "post", `/api/fields/${skillsOne}/skills-run`, { team_id: teams[0] });
    await expect(fieldTv.getByText("11A")).toBeVisible({ timeout: 10_000 });
    await clearSeen(skills);
    await clearSeen(fieldTv);
    const timer = (action: string) => call(request, "post", `/api/field-sets/${skillsRow}/skills-timer/${action}`, {});
    const setPhase = async () => (await call(request, "get", `/api/field-sets/${skillsRow}/skills`)).timer.phase as string;

    await timer("start");
    await expect.poll(() => cuesOf(skills), { timeout: 5_000 }).toEqual(["start"]);
    // The cue game's skills run lasts 6 s.
    await expect.poll(setPhase, { timeout: 15_000 }).toBe("ended");
    const time = fieldTv.locator('[data-testid="cue-flash"][data-kind="over"]');
    await expect(time).toBeVisible({ timeout: 5_000 });
    await expect(time).toHaveClass(/cue-flash--top/);
    await saveShot(fieldTv, testInfo, "skills-tv-white-time-top-1280x720");
    await expect.poll(() => cuesOf(skills), { timeout: 5_000 }).toEqual(["start", "beep", "beep", "beep", "buzzer"]);
    for (const page of [skills, fieldTv]) {
      const flashes = await flashesOf(page);
      expect(flashes.map((f) => `${f.kind}:${f.text}`)).toEqual(["over:TIME"]);
      expect(flashes[0].background).toBe(WHITE);
      expect(flashes[0].top).toBe(true);
    }

    // Resetting a timer that already ran out is silent.
    await clearSeen(skills);
    await clearSeen(fieldTv);
    await timer("reset");
    await expect.poll(setPhase, { timeout: 5_000 }).toBe("ready");
    await skills.waitForTimeout(1_500);
    expect(await cuesOf(skills)).toEqual([]);
    expect(await flashesOf(skills)).toEqual([]);
    expect(await flashesOf(fieldTv)).toEqual([]);

    await timer("start");
    await expect.poll(() => cuesOf(skills), { timeout: 5_000 }).toEqual(["start"]);
    await timer("end");
    const stopped = skills.locator('[data-testid="cue-flash"][data-kind="stop"]');
    await expect(stopped).toBeVisible({ timeout: 5_000 });
    await saveShot(skills, testInfo, "skills-tv-red-stopped-top-1280x720");
    await expect.poll(() => cuesOf(skills), { timeout: 5_000 }).toEqual(["start", "stop"]);
    for (const page of [skills, fieldTv]) {
      const flashes = await flashesOf(page);
      expect(flashes.map((f) => `${f.kind}:${f.text}`)).toEqual(["stop:STOPPED"]);
      expect(flashes[0].background).toBe(RED);
    }
    // The skills field TV's sound is off.
    expect(await cuesOf(fieldTv)).toEqual([]);

    await clearSeen(skills);
    await timer("reset");
    await expect.poll(setPhase, { timeout: 5_000 }).toBe("ready");
    await skills.waitForTimeout(1_500);
    expect(await cuesOf(skills)).toEqual([]);
  });
});
