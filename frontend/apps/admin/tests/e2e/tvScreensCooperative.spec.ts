import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";
import { expectFits, shot } from "./fixtures/tvFits";

const PASSWORD = "tv-screens-coop-e2e-pw";

interface MatchInfo {
  id: number;
  alliances: { id: number; station: string; team_ids: number[] }[];
}

test.describe.serial("TV screens for a cooperative game", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let tabletToken = "";
  let saturday = 0;
  let first = 0;
  let second = 0;
  let match: MatchInfo;
  let audienceGroup = 0;
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

  async function pairDisplay(browser: Browser, request: APIRequestContext, name: string, groupId: number) {
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: paired.id, group_id: groupId });
    screens[name] = page;
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

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8183, frontendPort: 5244, devicePort: 5245 });
    expect((await request.post(api("/api/event"), { data: { name: "Cooperative TV League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: admin(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "sample_cooperative" });
    first = (await call(request, "post", "/api/teams", { number: "70001A", name: "Together One" })).id;
    second = (await call(request, "post", "/api/teams", { number: "70002B", name: "Together Two" })).id;
    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    const mainFields = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    const fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 1" })).id;
    match = await call(request, "post", "/api/matches", {
      session_id: saturday,
      round_type: "qualification",
      match_number: 1,
      field_id: fieldOne,
      scheduled_time: new Date(Date.now() + 10 * 60_000).toISOString(),
      alliances: [
        { station: "red", team_ids: [first] },
        { station: "blue", team_ids: [second] },
      ],
    });
    tabletToken = await pairTablet(request, "Tablet 1");
    const groups = (await call(request, "get", `/api/displays?session_id=${saturday}`)).groups as {
      id: number;
      kind: string;
      field_set_id: number | null;
      field_id: number | null;
    }[];
    const audience = groups.find((group) => group.kind === "audience" && group.field_set_id === mainFields)!;
    const field = groups.find((group) => group.kind === "field" && group.field_id === fieldOne)!;
    audienceGroup = audience.id;
    await pairDisplay(browser, request, "Field TV", field.id);
    await pairDisplay(browser, request, "Audience TV", audience.id);
  });

  test.afterAll(() => server?.stop());

  const numbers = () => [`band-number-${first}`, `band-number-${second}`];

  test("before the match, the first team is on the red band and the second on the blue band", async ({}, testInfo) => {
    const page = screens["Field TV"];
    await expect(page.getByTestId("bottom-bar")).toContainText("Qualification 1", { timeout: 15_000 });
    await expect(page.getByTestId("start")).toBeVisible();
    await expect(page.getByTestId("band-red")).toHaveText("70001A");
    await expect(page.getByTestId("band-blue")).toHaveText("70002B");
    await expectFits(page, ["band-red", "band-blue", "bottom-bar", ...numbers()]);
    await shot(page, testInfo, "coop-field-next-1920x1080");
  });

  test("during the match, one combined live total shows once a draft arrives", async ({ request }, testInfo) => {
    await call(request, "post", `/api/matches/${match.id}/start`, {});
    for (const page of [screens["Field TV"], screens["Audience TV"]]) {
      // This game has no autonomous period: the clock runs straight into driver control.
      await expect(page.getByTestId("period")).toHaveText("Driver control", { timeout: 15_000 });
      await expect(page.getByTestId("band-red")).toHaveText("70001A");
      await expect(page.getByTestId("band-blue")).toHaveText("70002B");
    }
    await call(
      request,
      "patch",
      `/api/matches/${match.id}/alliances/${match.alliances[0].id}/draft`,
      { changes: { score: 7 } },
      { Authorization: `Bearer ${tabletToken}` }
    );
    for (const page of [screens["Field TV"], screens["Audience TV"]]) {
      await expect(page.getByTestId("live-combined")).toContainText("7", { timeout: 10_000 });
      await expect(page.getByTestId("live-combined")).toContainText("Live");
      await expect(page.getByTestId("live-red")).toHaveCount(0);
      await expect(page.getByTestId("live-blue")).toHaveCount(0);
      await expectFits(page, ["band-red", "band-blue", "clock", "period", "bottom-bar", "live-combined", ...numbers()]);
    }
    await shot(screens["Field TV"], testInfo, "coop-in-match-1920x1080");
    await call(request, "post", `/api/matches/${match.id}/end`, {});
    await expect(screens["Field TV"].getByText("Match over")).toBeVisible({ timeout: 10_000 });
  });

  test("the result shows one combined score, both teams in their side colours and no winner", async ({ request }, testInfo) => {
    await call(request, "post", `/api/matches/${match.id}/alliances/${match.alliances[0].id}/score`, { data: { score: 42 } });
    // The operator puts the result up once the score is saved, as Match Control's "Last Scored Match" does.
    await call(request, "patch", `/api/displays/groups/${audienceGroup}`, { screen: "last_scored_match" });
    const page = screens["Audience TV"];
    await expect(page.getByTestId("bottom-bar")).toContainText("Result · Qualification 1", { timeout: 15_000 });
    await expect(page.getByTestId("score-combined")).toHaveText("42");
    await expect(page.getByTestId("winner")).toHaveCount(0);
    await expect(page.getByTestId("score-red")).toHaveCount(0);
    await expect(page.getByTestId("score-blue")).toHaveCount(0);
    await expect(page.getByTestId("result-red")).toContainText("70001A");
    await expect(page.getByTestId("result-blue")).toContainText("70002B");
    await expect(page.getByTestId("result-red")).not.toHaveClass(/is-loser/);
    await expect(page.getByTestId("result-blue")).not.toHaveClass(/is-loser/);
    await expectFits(page, ["result-red", "result-blue", "score-combined", "bottom-bar"]);
    await shot(page, testInfo, "coop-result-1920x1080");
  });
});
