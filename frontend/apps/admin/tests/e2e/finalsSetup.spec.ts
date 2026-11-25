import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildExampleGamePluginZip, buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

interface MatchInfo {
  id: number;
  is_finals: boolean;
  label: string;
  field_id: number | null;
  alliances: { id: number; station: string; team_ids: number[] }[];
}

/** One isolated event: its server, an admin token, an active session with one
 * field set of `fieldNames`, checked-in teams, and helpers for its API. */
function finalsEvent(
  ports: { backendPort: number; frontendPort: number; devicePort?: number },
  password: string,
  plugin: () => Promise<{ zip: string; name: string }>
) {
  const state = {
    server: undefined as unknown as IsolatedServer,
    token: "",
    session: 0,
    fieldSet: 0,
    fields: {} as Record<string, number>,
    teams: [] as number[],
    numberOf: {} as Record<number, string>,
  };
  const api = (route: string) => `${state.server.apiUrl}${route}`;
  async function call(request: APIRequestContext, method: "get" | "post" | "put" | "patch", route: string, data?: unknown) {
    const response = await request[method](api(route), { headers: { Authorization: `Bearer ${state.token}` }, data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }
  async function setUp(request: APIRequestContext, teamNumbers: string[], fieldNames: string[]) {
    state.server = await startIsolatedServer(ports);
    expect((await request.post(api("/api/event"), { data: { name: "Finals League", password } })).status()).toBe(201);
    state.token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password } })).json()).access_token;
    const { zip, name } = await plugin();
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: { Authorization: `Bearer ${state.token}` },
      multipart: { file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(zip) } },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name });
    state.session = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: state.session });
    state.fieldSet = (await call(request, "post", "/api/field-sets", { session_id: state.session, name: "Main Fields" })).id;
    for (const fieldName of fieldNames) {
      state.fields[fieldName] = (
        await call(request, "post", "/api/fields", { session_id: state.session, field_set_id: state.fieldSet, name: fieldName })
      ).id;
    }
    for (const [index, number] of teamNumbers.entries()) {
      const id = (await call(request, "post", "/api/teams", { number, name: `Finalist ${index + 1}` })).id;
      state.teams.push(id);
      state.numberOf[id] = number;
      await call(request, "post", `/api/sessions/${state.session}/participants`, { team_id: id, checked_in: true });
    }
  }
  async function qualify(request: APIRequestContext, red: number[], blue: number[], number: number) {
    return (await call(request, "post", "/api/matches", {
      session_id: state.session,
      round_type: "qualification",
      match_number: number,
      field_id: Object.values(state.fields)[0],
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
  /** Team numbers in rank order: index 0 is rank 1. */
  async function rankedNumbers(request: APIRequestContext) {
    const rankings = (await call(request, "get", `/api/rankings?session_id=${state.session}`)) as { team_id: number; rank: number }[];
    return [...rankings].sort((a, b) => a.rank - b.rank).map((row) => state.numberOf[row.team_id]);
  }
  async function adminPage(browser: Browser, path: string): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${state.server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    return page;
  }
  return { state, call, setUp, qualify, finalize, rankedNumbers, adminPage };
}

const rankingsTable = (page: Page) => page.getByRole("table", { name: "Rankings for finals" });
const rowOf = (page: Page, number: string) => rankingsTable(page).getByRole("row").filter({ hasText: number });
const finalsCell = (page: Page, number: string) => rowOf(page, number).getByRole("cell").nth(2);

test.describe.serial("finals set-up, head-to-head", () => {
  test.describe.configure({ timeout: 180_000 });
  const event = finalsEvent({ backendPort: 8214, frontendPort: 5276, devicePort: 5277 }, "finals-setup-e2e-pw", async () => ({
    zip: await buildExampleGamePluginZip(),
    name: "example-game",
  }));
  const numbers = Array.from({ length: 10 }, (_, i) => `${3301 + i}F`);
  let ranked: string[] = [];
  let admin: Page;

  test.beforeAll(async ({ request }) => {
    await event.setUp(request, numbers, ["Field 1", "Field 2"]);
    const teams = event.state.teams;
    // Every team plays twice; the scores spread the teams out.
    const plan: [number[], number[], number, number][] = [
      [[0, 1], [2, 3], 9, 2],
      [[4, 5], [6, 7], 7, 3],
      [[8, 9], [0, 2], 5, 8],
      [[1, 3], [4, 6], 6, 4],
      [[5, 7], [8, 9], 3, 10],
    ];
    for (const [index, [red, blue, redBalls, blueBalls]] of plan.entries()) {
      const match = await event.qualify(request, red.map((i) => teams[i]), blue.map((i) => teams[i]), index + 1);
      for (const alliance of match.alliances) {
        await event.call(request, "post", `/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          data: { high_balls: alliance.station === "red" ? redBalls : blueBalls, low_balls: 0, auto_winner: "tie" },
        });
      }
    }
  });

  test.afterAll(() => event.state.server?.stop());

  test("a session whose qualification isn't finalized says so and links to Matches", async ({ browser }) => {
    admin = await event.adminPage(browser, `/sessions/${event.state.session}/finals`);
    await expect(admin.getByText("Finalize qualification on the Matches page before generating finals.")).toBeVisible({ timeout: 15_000 });
    await admin.getByRole("link", { name: "Go to Matches" }).click();
    await expect(admin).toHaveURL(new RegExp(`/sessions/${event.state.session}/matches$`));
  });

  test("after finalizing, the Matches page links to Finals, which shows captains and invitable teams", async ({ request }) => {
    await event.finalize(request);
    ranked = await event.rankedNumbers(request);
    expect(ranked).toHaveLength(10);
    await admin.reload();
    await admin.getByRole("link", { name: "Set up finals" }).click();
    await expect(admin).toHaveURL(new RegExp(`/sessions/${event.state.session}/finals$`));
    await expect(rankingsTable(admin)).toBeVisible({ timeout: 15_000 });

    // Exclude rank 3 as disqualified.
    await rowOf(admin, ranked[2]).getByRole("button", { name: "Exclude…" }).click();
    await expect(rowOf(admin, ranked[2]).getByLabel("Reason")).toHaveValue("disqualified");
    await rowOf(admin, ranked[2]).getByRole("button", { name: "Exclude", exact: true }).click();
    await expect(finalsCell(admin, ranked[2])).toHaveText("Excluded: disqualified");
    await expect(rowOf(admin, ranked[2])).toHaveClass(/finals-rankings__excluded/);

    await admin.getByLabel("Teams in finals").fill("8");
    await expect(admin.getByText("4 alliances")).toBeVisible();
    await expect(admin.getByRole("radio", { name: "Partner picking" })).toBeChecked();
    for (const [index, rank] of [1, 2, 4, 5].entries()) {
      await expect(finalsCell(admin, ranked[rank - 1])).toHaveText(`Captain ${index + 1}`);
    }
    for (const rank of [6, 7, 8, 9, 10]) {
      await expect(finalsCell(admin, ranked[rank - 1])).toHaveText("Can be invited");
    }
    await expect(rankingsTable(admin).locator(".finals-rankings__cut")).toHaveCount(0);
    await expect(admin.getByRole("button", { name: "Start alliance selection" })).toBeEnabled();
  });

  test("automatic pairs draw the cut line after rank 9, with rank 3 left out", async () => {
    await admin.getByRole("radio", { name: "Automatic pairs" }).check();
    await expect(rankingsTable(admin).locator(".finals-rankings__cut")).toHaveCount(1);
    await expect(rowOf(admin, ranked[8])).toHaveClass(/finals-rankings__cut/);
    await expect(finalsCell(admin, ranked[2])).toHaveText("Excluded: disqualified");
    await expect(finalsCell(admin, ranked[0])).toHaveText("Alliance 1");
    await expect(finalsCell(admin, ranked[1])).toHaveText("Alliance 1");
    await expect(finalsCell(admin, ranked[3])).toHaveText(/^Alliance 2/);
    await expect(finalsCell(admin, ranked[8])).toHaveText(/^Alliance 4/);
    await expect(finalsCell(admin, ranked[9])).toHaveText("Not in finals");
  });

  test("best 2 of 3 final on the ticked field: finals start with 4 alliances and Match Control's next match is there", async () => {
    const finalChoice = admin
      .locator("label.finals-settings__round")
      .filter({ has: admin.locator("span", { hasText: /^Final$/ }) })
      .locator("select");
    await finalChoice.selectOption("best2of3");
    await expect(finalChoice).toHaveValue("best2of3");
    await admin.getByRole("checkbox", { name: "Field 2" }).uncheck();
    await expect(admin.getByRole("checkbox", { name: "Field 1" })).toBeChecked();
    await admin.getByRole("button", { name: "Create finals matches" }).click();

    const progress = admin.getByRole("table", { name: "Alliances in finals" });
    await expect(progress).toBeVisible({ timeout: 15_000 });
    await expect(admin.getByText("Finals are in progress.")).toBeVisible();
    await expect(progress.locator("tbody tr")).toHaveCount(4);
    await expect(progress.locator("tbody tr").first()).toContainText(ranked[0]);
    await expect(progress.locator("tbody tr").first()).toContainText(ranked[1]);
    await expect(progress).not.toContainText(ranked[2]);

    await admin.getByRole("link", { name: "Open Match Control" }).click();
    const next = admin.getByRole("region", { name: "Next match" });
    await expect(next).toContainText("Field 1", { timeout: 15_000 });
    await expect(next).not.toContainText("Field 2");
  });
});

test.describe.serial("finals set-up, score chase", () => {
  test.describe.configure({ timeout: 180_000 });
  // A second plugin needs a second event, so it gets its own server (no device app).
  const event = finalsEvent({ backendPort: 8215, frontendPort: 5278 }, "finals-chase-e2e-pw", async () => ({
    zip: await buildSampleCooperativePluginZip(),
    name: "sample_cooperative",
  }));
  const numbers = Array.from({ length: 5 }, (_, i) => `${4401 + i}C`);

  test.beforeAll(async ({ request }) => {
    await event.setUp(request, numbers, ["Field 1"]);
    const teams = event.state.teams;
    const plan: [number, number, number][] = [
      [0, 1, 50],
      [2, 3, 30],
      [4, 0, 12],
      [1, 2, 41],
      [3, 4, 7],
    ];
    for (const [index, [red, blue, score]] of plan.entries()) {
      const match = await event.qualify(request, [teams[red]], [teams[blue]], index + 1);
      await event.call(request, "post", `/api/matches/${match.id}/alliances/${match.alliances[0].id}/score`, { data: { score } });
    }
    await event.finalize(request);
  });

  test.afterAll(() => event.state.server?.stop());

  test("All teams with an odd count creates runs from the bottom, ranks 4 and 5 first", async ({ browser, request }) => {
    const ranked = await event.rankedNumbers(request);
    expect(ranked).toHaveLength(5);
    const admin = await event.adminPage(browser, `/sessions/${event.state.session}/finals`);
    await expect(rankingsTable(admin)).toBeVisible({ timeout: 15_000 });
    await expect(admin.getByRole("radio", { name: "Partner picking" })).toHaveCount(0);
    await admin.getByLabel("Teams in finals").fill("2");
    await admin.getByRole("button", { name: "All teams" }).click();
    await expect(admin.getByLabel("Teams in finals")).toHaveValue("5");
    await expect(rankingsTable(admin).locator(".finals-rankings__cut")).toHaveCount(1);
    await expect(rowOf(admin, ranked[4])).toHaveClass(/finals-rankings__cut/);
    await admin.getByRole("button", { name: "Create finals runs" }).click();
    await expect(admin.getByRole("table", { name: "Alliances in finals" })).toBeVisible({ timeout: 15_000 });

    const runs = ((await event.call(request, "get", `/api/matches?session_id=${event.state.session}`)) as MatchInfo[])
      .filter((match) => match.is_finals)
      .sort((a, b) => a.id - b.id);
    expect(runs.length).toBeGreaterThan(0);
    const firstPair = runs[0].alliances.flatMap((alliance) => alliance.team_ids).map((id) => event.state.numberOf[id]);
    expect(firstPair.sort()).toEqual([ranked[3], ranked[4]].sort());
  });
});
