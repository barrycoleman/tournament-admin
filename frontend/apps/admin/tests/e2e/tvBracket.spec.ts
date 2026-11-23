import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildExampleGamePluginZip, buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";
import { shot } from "./fixtures/tvFits";

interface MatchInfo {
  id: number;
  is_finals: boolean;
  label: string;
  alliances: { id: number; station: string; team_ids: number[] }[];
}
interface Bracket {
  id: number;
  alliances: { id: number; seed: number; team_ids: number[] }[];
  matchups: { id: number; round_number: number; position: number; alliance_a_id: number | null; alliance_b_id: number | null }[];
}

/** One isolated event per game: its server, an admin login, a session with one
 * field set and field, and a pit TV at 1920×1080 showing the bracket screen. */
function bracketEvent(ports: { backendPort: number; frontendPort: number; devicePort: number }, password: string) {
  const state = { server: undefined as unknown as IsolatedServer, token: "", session: 0, fieldSet: 0, field: 0, tv: undefined as unknown as Page };
  const api = (route: string) => `${state.server.apiUrl}${route}`;
  async function call(request: APIRequestContext, method: "get" | "post" | "put" | "patch", route: string, data?: unknown) {
    const response = await request[method](api(route), { headers: { Authorization: `Bearer ${state.token}` }, data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }
  async function setUp(request: APIRequestContext, plugin: { zip: string; name: string }) {
    state.server = await startIsolatedServer(ports);
    expect((await request.post(api("/api/event"), { data: { name: "Bracket League", password } })).status()).toBe(201);
    state.token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: { Authorization: `Bearer ${state.token}` },
      multipart: { file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(plugin.zip) } },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: plugin.name });
    state.session = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: state.session });
    state.fieldSet = (await call(request, "post", "/api/field-sets", { session_id: state.session, name: "Main Fields" })).id;
    state.field = (await call(request, "post", "/api/fields", { session_id: state.session, field_set_id: state.fieldSet, name: "Field 1" })).id;
  }
  async function qualify(request: APIRequestContext, red: number[], blue: number[], number: number) {
    return (await call(request, "post", "/api/matches", {
      session_id: state.session,
      round_type: "qualification",
      match_number: number,
      field_id: state.field,
      alliances: [
        { station: "red", team_ids: red },
        { station: "blue", team_ids: blue },
      ],
    })) as MatchInfo;
  }
  async function finalize(request: APIRequestContext) {
    const preview = await call(request, "get", `/api/sessions/${state.session}/qualification/finalize-preview`);
    const drops = Object.fromEntries(((preview.rows ?? []) as { played: number; suggested: number }[]).map((row) => [String(row.played), row.suggested]));
    await call(request, "post", `/api/sessions/${state.session}/qualification/finalize`, { drops });
  }
  async function showBracket(browser: Browser, request: APIRequestContext) {
    const pit = await call(request, "post", "/api/displays/pit-groups", { session_id: state.session, name: "Pit Bracket" });
    await call(request, "patch", `/api/displays/groups/${pit.id}`, { screen: "elimination_bracket" });
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    await page.goto(`${state.server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name: "Pit Bracket TV" });
    await expect(page.getByText("Pit Bracket TV")).toBeVisible({ timeout: 15_000 });
    await call(request, "put", "/api/displays/assignments", { session_id: state.session, device_id: paired.id, group_id: pit.id });
    state.tv = page;
    return page;
  }
  return { state, call, setUp, qualify, finalize, showBracket };
}

test.describe.serial("TV elimination bracket, single elimination", () => {
  test.describe.configure({ timeout: 120_000 });
  const event = bracketEvent({ backendPort: 8193, frontendPort: 5254, devicePort: 5255 }, "tv-bracket-e2e-pw");
  let bracket: Bracket;
  const teams: number[] = [];

  test.beforeAll(async ({ request }) => {
    await event.setUp(request, { zip: await buildExampleGamePluginZip(), name: "example-game" });
    for (let i = 1; i <= 8; i++) teams.push((await event.call(request, "post", "/api/teams", { number: `${1100 + i}E`, name: `Bracket ${i}` })).id);
    for (const id of teams) await event.call(request, "post", `/api/sessions/${event.state.session}/participants`, { team_id: id, checked_in: true });
    const plan: [number[], number[], number, number][] = [
      [[0, 1], [2, 3], 8, 2],
      [[4, 5], [6, 7], 6, 4],
    ];
    for (const [index, [red, blue, redBalls, blueBalls]] of plan.entries()) {
      const match = await event.qualify(request, red.map((i) => teams[i]), blue.map((i) => teams[i]), index + 1);
      for (const alliance of match.alliances) {
        await event.call(request, "post", `/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          data: { high_balls: alliance.station === "red" ? redBalls : blueBalls, low_balls: 0, auto_winner: "tie" },
        });
      }
    }
    await event.finalize(request);
    bracket = await event.call(request, "post", "/api/finals/start", {
      session_id: event.state.session, bracket_size: 4, wins_to_advance: 1, field_set_id: event.state.fieldSet,
    });
    // Each captain, in seed order, picks the first team not yet on an alliance.
    const claimed = new Set(bracket.alliances.flatMap((a) => a.team_ids));
    for (const alliance of [...bracket.alliances].sort((a, b) => a.seed - b.seed)) {
      const partner = teams.find((id) => !claimed.has(id))!;
      claimed.add(partner);
      bracket = await event.call(request, "post", `/api/finals/${bracket.id}/pick`, { captain_bracket_alliance_id: alliance.id, partner_team_id: partner });
    }
  });

  test.afterAll(() => event.state.server?.stop());

  test("a filled matchup shows alliance A red and B blue, an empty slot is neutral, and there is no side panel", async ({ browser, request }, testInfo) => {
    const opening = bracket.matchups.find((m) => m.round_number === 1 && m.position === 0)!;
    const final = bracket.matchups.find((m) => m.round_number === Math.max(...bracket.matchups.map((x) => x.round_number)))!;
    expect(opening.alliance_a_id).not.toBeNull();
    expect(opening.alliance_b_id).not.toBeNull();
    expect(final.alliance_a_id).toBeNull();
    const tv = await event.showBracket(browser, request);
    const matchup = tv.getByTestId(`matchup-${opening.id}`);
    await expect(matchup).toBeVisible({ timeout: 15_000 });
    await expect(tv.getByRole("heading", { name: "Semifinals" })).toBeVisible();
    await expect(tv.getByRole("heading", { name: "Final", exact: true })).toBeVisible();
    await expect(matchup.getByTestId(`side-${opening.alliance_a_id}`)).toHaveClass(/matchup__side--red/);
    await expect(matchup.getByTestId(`side-${opening.alliance_b_id}`)).toHaveClass(/matchup__side--blue/);
    const empty = tv.getByTestId(`matchup-${final.id}`).locator(".matchup__side");
    await expect(empty).toHaveCount(2);
    for (const side of await empty.all()) {
      await expect(side).toHaveClass(/matchup__side--empty/);
      await expect(side).not.toHaveClass(/matchup__side--(red|blue)/);
    }
    await expect(tv.getByRole("complementary")).toHaveCount(0);
    await expect(tv.locator(".side-panel")).toHaveCount(0);
    await shot(tv, testInfo, "bracket-single-elimination-1920x1080");
  });
});

test.describe.serial("TV elimination bracket, score chase", () => {
  test.describe.configure({ timeout: 120_000 });
  const event = bracketEvent({ backendPort: 8194, frontendPort: 5256, devicePort: 5257 }, "tv-bracket-chase-e2e-pw");
  const teams: number[] = [];
  const numberOf: Record<number, string> = {};

  test.beforeAll(async ({ request }) => {
    await event.setUp(request, { zip: await buildSampleCooperativePluginZip(), name: "sample_cooperative" });
    for (let i = 1; i <= 4; i++) {
      const number = `${2200 + i}C`;
      const id = (await event.call(request, "post", "/api/teams", { number, name: `Chase ${i}` })).id;
      teams.push(id);
      numberOf[id] = number;
    }
    // Averages: team 1 25, team 2 30, team 3 15, team 4 10, so the ranks are 2, 1, 3, 4.
    const plan: [number, number, number][] = [
      [0, 1, 30],
      [2, 3, 10],
      [0, 2, 20],
    ];
    for (const [index, [red, blue, score]] of plan.entries()) {
      const match = await event.qualify(request, [teams[red]], [teams[blue]], index + 1);
      await event.call(request, "post", `/api/matches/${match.id}/alliances/${match.alliances[0].id}/score`, { data: { score } });
    }
    await event.finalize(request);
    await event.call(request, "post", "/api/finals/start", { session_id: event.state.session, bracket_size: 2, field_set_id: event.state.fieldSet });
  });

  test.afterAll(() => event.state.server?.stop());

  test("each run shows its finalist pair by side, the better ranked team red, with no side panel", async ({ browser, request }, testInfo) => {
    const rankings = (await event.call(request, "get", `/api/rankings?session_id=${event.state.session}`)) as { team_id: number; rank: number }[];
    const rank = new Map(rankings.map((r) => [r.team_id, r.rank]));
    const runs = ((await event.call(request, "get", `/api/matches?session_id=${event.state.session}`)) as MatchInfo[]).filter((m) => m.is_finals);
    expect(runs).toHaveLength(1);
    const pair = runs[0].alliances[0].team_ids;
    expect(pair).toHaveLength(2);
    const [better, other] = [...pair].sort((a, b) => rank.get(a)! - rank.get(b)!);

    const tv = await event.showBracket(browser, request);
    const table = tv.getByRole("table", { name: "Finals rankings" });
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(table.getByRole("row").nth(0)).toContainText(/Rank.*Match.*Red.*Blue.*Score/);
    const row = table.getByRole("row", { name: new RegExp(runs[0].label) });
    await expect(row.locator(".team-numbers--red")).toHaveText(numberOf[better]);
    await expect(row.locator(".team-numbers--blue")).toHaveText(numberOf[other]);
    await expect(row).toHaveClass(/is-current/);
    await expect(tv.getByRole("complementary")).toHaveCount(0);
    await expect(tv.getByText("Match schedule & results")).toHaveCount(0);

    // The run is scored: it ranks first with its score, and the next pair's run appears.
    await event.call(request, "post", `/api/matches/${runs[0].id}/alliances/${runs[0].alliances[0].id}/score`, { data: { score: 42 } });
    await expect(table.getByRole("row")).toHaveCount(3, { timeout: 10_000 });
    const scored = table.getByRole("row").nth(1);
    await expect(scored).toContainText(runs[0].label);
    await expect(scored).toContainText("42");
    await expect(scored.locator(".team-numbers--red")).toHaveText(numberOf[better]);
    const next = table.getByRole("row").nth(2);
    await expect(next.locator(".team-numbers--red")).toHaveCount(1);
    await expect(next.locator(".team-numbers--blue")).toHaveCount(1);
    await shot(tv, testInfo, "bracket-score-chase-1920x1080");
  });
});
