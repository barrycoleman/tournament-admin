import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "live-scoring-e2e-pw";

interface MatchInfo {
  id: number;
  label: string;
  is_finals: boolean;
  alliances: { id: number; station: string; team_ids: number[] }[];
}

test.describe.serial("live scoring", () => {
  test.describe.configure({ timeout: 180_000 });

  let server: IsolatedServer;
  let token = "";
  let tabletToken = "";
  let friday = 0;
  let saturday = 0;
  let mainFields = 0;
  let skillsRow = 0;
  const teams: number[] = [];
  const skillsFields: Record<string, number> = {};
  const matches: Record<string, MatchInfo> = {};
  const screens: Record<string, Page> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const admin = () => ({ Authorization: `Bearer ${token}` });
  const tablet = () => ({ Authorization: `Bearer ${tabletToken}` });

  async function call(
    request: APIRequestContext,
    method: "get" | "post" | "put" | "patch" | "delete",
    route: string,
    data?: unknown,
    headers: Record<string, string> = admin()
  ) {
    const response = await request[method](api(route), { headers, data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  async function createMatch(request: APIRequestContext, sessionId: number, number: number, fieldId: number, red: number, blue: number) {
    return (await call(request, "post", "/api/matches", {
      session_id: sessionId,
      round_type: "qualification",
      match_number: number,
      field_id: fieldId,
      scheduled_time: new Date(Date.now() + number * 5 * 60_000).toISOString(),
      alliances: [
        { station: "red", team_ids: [teams[red]] },
        { station: "blue", team_ids: [teams[blue]] },
      ],
    })) as MatchInfo;
  }

  /** A scorer tablet paired through the API; its token sends draft changes as "Tablet 2". */
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

  async function pairDisplay(browser: Browser, request: APIRequestContext, name: string): Promise<number> {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    screens[name] = page;
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    return paired.id;
  }

  async function adminPage(browser: Browser, path: string): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    return { page, context };
  }

  const draftPath = (match: MatchInfo) => `/api/matches/${match.id}/alliances/${match.alliances[0].id}/draft`;

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8143, frontendPort: 5204, devicePort: 5205 });
    expect((await request.post(api("/api/event"), { data: { name: "Live League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: admin(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "sample_cooperative" });
    await call(request, "put", "/api/skills/settings", { enabled: true, attempts: {} });
    for (const [number, name] of [["11A", "Alpha"], ["22B", "Bravo"], ["33C", "Charlie"], ["44D", "Delta"], ["55E", "Echo"], ["66F", "Foxtrot"]]) {
      teams.push((await call(request, "post", "/api/teams", { number, name })).id);
    }

    // An earlier session with one scored match, for the correction test.
    friday = (await call(request, "post", "/api/sessions", { label: "Friday", session_date: "2026-11-06" })).id;
    const fridaySet = (await call(request, "post", "/api/field-sets", { session_id: friday, name: "Friday Fields" })).id;
    const fridayField = (await call(request, "post", "/api/fields", { session_id: friday, field_set_id: fridaySet, name: "Field F" })).id;
    matches.FQ1 = await createMatch(request, friday, 1, fridayField, 0, 1);
    await call(request, "post", `/api/matches/${matches.FQ1.id}/alliances/${matches.FQ1.alliances[0].id}/score`, { data: { score: 30 } });

    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday", session_date: "2026-11-07" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    for (const teamId of teams) {
      await call(request, "post", `/api/sessions/${saturday}/participants`, { team_id: teamId, checked_in: true });
    }
    mainFields = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    const fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 1" })).id;
    const fieldTwo = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 2" })).id;
    skillsRow = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Skills Row", purpose: "skills" })).id;
    for (const name of ["Skills 1", "Skills 2", "Skills 3"]) {
      skillsFields[name] = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: skillsRow, name })).id;
    }
    matches.Q1 = await createMatch(request, saturday, 1, fieldOne, 0, 1);
    matches.Q2 = await createMatch(request, saturday, 2, fieldTwo, 2, 3);
    matches.Q3 = await createMatch(request, saturday, 3, fieldOne, 4, 5);

    tabletToken = await pairTablet(request, "Tablet 2");
    const bigTv = await pairDisplay(browser, request, "Big TV");
    const skillsTv = await pairDisplay(browser, request, "Skills TV");
    const groups = (await call(request, "get", `/api/displays?session_id=${saturday}`)).groups as {
      id: number;
      kind: string;
      field_set_id: number | null;
      field_id: number | null;
    }[];
    const audience = groups.find((group) => group.kind === "audience" && group.field_set_id === mainFields)!;
    const skillsFieldGroup = groups.find((group) => group.kind === "field" && group.field_id === skillsFields["Skills 1"])!;
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: bigTv, group_id: audience.id });
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: skillsTv, group_id: skillsFieldGroup.id });
  });

  test.afterAll(() => server?.stop());

  test("the audience sees a live total while the clock runs and loses it when time ends", async ({ request }) => {
    const bigTv = screens["Big TV"];
    await call(request, "post", `/api/matches/${matches.Q1.id}/start`, {});
    await expect(bigTv.getByRole("heading", { name: "Qualification 1" })).toBeVisible({ timeout: 10_000 });
    await call(request, "patch", draftPath(matches.Q1), { changes: { score: 7 } }, tablet());
    const live = bigTv.getByTestId("live-all");
    await expect(live).toContainText("7", { timeout: 10_000 });
    await expect(live).toContainText("Live");

    await call(request, "post", `/api/matches/${matches.Q1.id}/end`, {});
    await expect(bigTv.getByText("Match over")).toBeVisible({ timeout: 10_000 });
    await expect(live).toHaveCount(0);
    expect((await call(request, "get", `/api/displays/live-scores?field_set_id=${mainFields}`)).matches).toEqual([]);
  });

  test("two browsers score one match: a clash flashes on both and one Submit saves both", async ({ browser, request }) => {
    const path = `/sessions/${saturday}/matches/${matches.Q1.id}/score`;
    const first = (await adminPage(browser, path)).page;
    const second = (await adminPage(browser, path)).page;
    const firstScore = first.getByLabel("Score", { exact: true }).first();
    const secondScore = second.getByLabel("Score", { exact: true }).first();
    // The tablet's draft from the last test is already there.
    await expect(firstScore).toHaveValue("7", { timeout: 15_000 });
    await expect(secondScore).toHaveValue("7", { timeout: 15_000 });

    await firstScore.fill("5");
    await expect(secondScore).toHaveValue("5", { timeout: 10_000 });

    // The tablet changes the same item: the later write wins and both pages say who made it.
    await call(request, "patch", draftPath(matches.Q1), { changes: { score: 12 } }, tablet());
    await Promise.all([
      expect(first.getByText("Changed by Tablet 2").first()).toBeVisible({ timeout: 10_000 }),
      expect(second.getByText("Changed by Tablet 2").first()).toBeVisible({ timeout: 10_000 }),
    ]);
    await expect(firstScore).toHaveValue("12");
    await expect(secondScore).toHaveValue("12");

    await first.getByRole("button", { name: "Submit", exact: true }).click();
    // Once the match is official, the admin route swaps the live page for its read-only scores.
    for (const page of [first, second]) {
      await expect(page.getByRole("button", { name: "Correct score" })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("region", { name: "Red" }).getByText("Score: 12")).toBeVisible();
    }
    const scores = (await call(request, "get", `/api/scores?session_id=${saturday}`)) as { match_id: number; score: number }[];
    expect(scores.filter((row) => row.match_id === matches.Q1.id).map((row) => row.score)).toEqual([12, 12]);

    // A late change from the tablet is refused now that the score is official.
    const late = await request.patch(api(draftPath(matches.Q1)), { headers: tablet(), data: { changes: { score: 13 } } });
    expect(late.status()).toBe(409);
  });

  test("a finals match shows no live total until the finals switch is turned on", async ({ request }) => {
    await call(request, "post", `/api/matches/${matches.Q2.id}/alliances/${matches.Q2.alliances[0].id}/score`, { data: { score: 20 } });
    await call(request, "post", `/api/matches/${matches.Q3.id}/alliances/${matches.Q3.alliances[0].id}/score`, { data: { score: 10 } });
    const preview = await call(request, "get", `/api/sessions/${saturday}/qualification/finalize-preview`);
    const drops = Object.fromEntries(
      (preview.rows as { played: number; suggested: number }[]).map((row) => [String(row.played), row.suggested])
    );
    await call(request, "post", `/api/sessions/${saturday}/qualification/finalize`, { drops });
    await call(request, "post", "/api/finals/start", { session_id: saturday, bracket_size: 2, field_set_id: mainFields });
    const all = (await call(request, "get", `/api/matches?session_id=${saturday}`)) as MatchInfo[];
    matches.F1 = all.find((match) => match.is_finals)!;

    const bigTv = screens["Big TV"];
    await call(request, "post", `/api/matches/${matches.F1.id}/start`, {});
    await expect(bigTv.getByRole("heading", { name: `Final ${matches.F1.label}` })).toBeVisible({ timeout: 10_000 });
    await call(request, "patch", draftPath(matches.F1), { changes: { score: 9 } }, tablet());
    expect(await call(request, "get", `/api/displays/live-scores?field_set_id=${mainFields}`)).toEqual({ matches: [], skills: [] });
    // Nothing to wait for when nothing should arrive: give a stray live_score a moment to land.
    await bigTv.waitForTimeout(1_500);
    await expect(bigTv.getByTestId("live-all")).toHaveCount(0);

    await call(request, "patch", `/api/sessions/${saturday}`, { live_scores_finals: true });
    await expect(bigTv.getByTestId("live-all")).toContainText("9", { timeout: 10_000 });
    await call(request, "patch", `/api/sessions/${saturday}`, { live_scores_finals: false });
    await expect(bigTv.getByTestId("live-all")).toHaveCount(0, { timeout: 10_000 });
    await call(request, "post", `/api/matches/${matches.F1.id}/end`, {});
  });

  test("a scoring page that loses the network keeps its change and sends it when the network returns", async ({ browser, request }) => {
    const { page, context } = await adminPage(browser, `/sessions/${saturday}/matches/${matches.F1.id}/score`);
    const score = page.getByLabel("Score", { exact: true }).first();
    await expect(score).toHaveValue("9", { timeout: 15_000 });

    await context.setOffline(true);
    await score.fill("14");
    await expect(page.getByText("Offline, changes not saved yet")).toBeVisible({ timeout: 10_000 });
    expect((await call(request, "get", `/api/matches/${matches.F1.id}/draft`)).alliances[0].data.score).toBe(9);

    await context.setOffline(false);
    await expect(page.getByText("Offline, changes not saved yet")).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(async () => (await call(request, "get", `/api/matches/${matches.F1.id}/draft`)).alliances[0].data.score, { timeout: 10_000 })
      .toBe(14);
    await expect(score).toHaveValue("14");
  });

  test("a skills set timer starts two fields at once while a third runs alone, and the field TV shows the breakdown", async ({ browser, request }) => {
    const { page } = await adminPage(browser, "/skills-control");
    const card = page.getByRole("region", { name: "Skills Row" });
    const row = (name: string) => card.getByRole("row", { name });
    for (const [field, team] of [["Skills 1", "11A Alpha"], ["Skills 2", "22B Bravo"], ["Skills 3", "33C Charlie"]]) {
      await row(field).getByRole("button", { name: "Start run" }).click();
      const dialog = page.getByRole("alertdialog", { name: `Start a run on ${field}` });
      await dialog.getByLabel("Team").selectOption({ label: team });
      await dialog.getByRole("button", { name: "Start run" }).click();
      await expect(row(field)).toContainText("Ready");
    }
    const skillsTv = screens["Skills TV"];
    await expect(skillsTv.getByText("11A")).toBeVisible({ timeout: 10_000 });
    await expect(skillsTv.getByTestId("skills-clock")).toHaveText("1:00");

    // Skills 3's team runs on the field's own timer.
    await row("Skills 3").getByRole("group", { name: "Timer for Skills 3" }).getByRole("button", { name: "Start", exact: true }).click();
    await expect(row("Skills 3")).toContainText("Alone ·");
    await expect(row("Skills 3")).toContainText("Running");
    await expect(row("Skills 1")).toContainText("Ready");

    // The set timer starts Skills 1 and Skills 2 together.
    await card.getByRole("group", { name: "Set timer" }).getByRole("button", { name: "Start", exact: true }).click();
    await expect(row("Skills 1")).toContainText("Running");
    await expect(row("Skills 2")).toContainText("Running");
    const read = await call(request, "get", `/api/field-sets/${skillsRow}/skills`);
    const runs = Object.fromEntries(
      (read.fields as { name: string; run: { follows_set: boolean; phase: string; deadline: string | null } | null }[]).map(
        (field) => [field.name, field.run!]
      )
    );
    expect(runs["Skills 1"].follows_set).toBe(true);
    expect(runs["Skills 2"].follows_set).toBe(true);
    expect(runs["Skills 1"].deadline).toBe(runs["Skills 2"].deadline);
    expect(runs["Skills 3"].follows_set).toBe(false);
    expect(runs["Skills 3"].deadline).not.toBe(runs["Skills 1"].deadline);

    await call(request, "patch", `/api/fields/${skillsFields["Skills 1"]}/skills-run/draft`, { changes: { score: 33 } }, tablet());
    await expect(skillsTv.getByTestId("skills-live")).toContainText("33", { timeout: 10_000 });

    // Ending the set timer ends Skills 1 and 2; Skills 3 keeps running alone.
    await card.getByRole("group", { name: "Set timer" }).getByRole("button", { name: "End", exact: true }).click();
    await expect(skillsTv.getByText("Run over")).toBeVisible({ timeout: 10_000 });
    const breakdown = skillsTv.getByRole("list", { name: "Score breakdown" });
    await expect(breakdown).toContainText("Score");
    await expect(breakdown).toContainText("33");
    await expect(skillsTv.getByTestId("skills-total")).toHaveText("33");
    await expect(row("Skills 2")).toContainText("Ended");
    await expect(row("Skills 3")).toContainText("Running");

    await call(request, "post", `/api/fields/${skillsFields["Skills 1"]}/skills-run/submit`, {}, tablet());
    await expect(skillsTv.getByTestId("skills-final")).toHaveText("33", { timeout: 10_000 });
    await expect(row("Skills 1")).toContainText("Submitted");

    await row("Skills 2").getByRole("button", { name: "Discard" }).click();
    await page.getByRole("alertdialog", { name: "Discard the run on Skills 2?" }).getByRole("button", { name: "Discard run" }).click();
    await expect(row("Skills 2")).toContainText("No run");
    const attempts = (await call(request, "get", `/api/sessions/${saturday}/skills/attempts`)) as { team_id: number; field_id: number | null; score: number }[];
    expect(attempts.map((attempt) => [attempt.team_id, attempt.field_id, attempt.score])).toEqual([
      [teams[0], skillsFields["Skills 1"], 33],
    ]);
  });

  test("an admin corrects a score in an earlier session and its rankings follow", async ({ browser, request }) => {
    const { page } = await adminPage(browser, `/sessions/${friday}/matches/${matches.FQ1.id}/score`);
    await expect(page.getByRole("button", { name: "Correct score" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("30").first()).toBeVisible();
    await page.getByRole("button", { name: "Correct score" }).click();
    // A cooperative match may show its sheet once per alliance: correct every copy.
    for (const input of await page.getByLabel("Score", { exact: true }).all()) await input.fill("45");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect
      .poll(
        async () => ((await call(request, "get", `/api/scores?session_id=${friday}`)) as { score: number }[]).map((row) => row.score),
        { timeout: 10_000 }
      )
      .toEqual([45, 45]);
    const rankings = (await call(request, "get", `/api/rankings?session_id=${friday}`)) as { team_id: number; average_score: number }[];
    expect(rankings.find((row) => row.team_id === teams[0])?.average_score).toBe(45);
  });
});
