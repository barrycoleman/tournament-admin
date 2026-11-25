import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";
import { expectFits, shot } from "./fixtures/tvFits";

const PASSWORD = "alliance-picking-e2e-pw";

interface MatchInfo {
  id: number;
  alliances: { id: number; station: string; team_ids: number[] }[];
}

/** Partner picking end to end: the admin page, a scorer tablet in the device
 * app and an audience TV on the alliance selection screen stay in step. */
test.describe.serial("alliance picking", () => {
  test.describe.configure({ timeout: 180_000 });

  let server: IsolatedServer;
  let token = "";
  let session = 0;
  let fieldSet = 0;
  let field = 0;
  const teams: number[] = [];
  const numberOf: Record<number, string> = {};
  /** Team numbers in rank order: R[1] is rank 1. */
  const R: string[] = [];
  let admin: Page;
  let tablet: Page;
  let tv: Page;
  const api = (route: string) => `${server.apiUrl}${route}`;

  async function call(request: APIRequestContext, method: "get" | "post" | "put" | "patch", route: string, data?: unknown) {
    const response = await request[method](api(route), { headers: { Authorization: `Bearer ${token}` }, data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  /** A browser on the device app, paired through the API with the given role. */
  async function pairBrowser(browser: Browser, request: APIRequestContext, role: string, name: string, viewport: { width: number; height: number }) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role, name });
    return { page, id: paired.id as number };
  }

  const adminAlliances = () => admin.getByRole("table", { name: "Alliances", exact: true });
  const adminAllianceRow = (seed: number) => adminAlliances().locator("tbody tr").nth(seed - 1);
  const adminInvitable = () => admin.getByRole("list", { name: "Can be invited" });

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8213, frontendPort: 5274, devicePort: 5275 });
    expect((await request.post(api("/api/event"), { data: { name: "Picking League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildExampleGamePluginZip()) } },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "example-game" });
    session = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: session });
    fieldSet = (await call(request, "post", "/api/field-sets", { session_id: session, name: "Main Fields" })).id;
    field = (await call(request, "post", "/api/fields", { session_id: session, field_set_id: fieldSet, name: "Field 1" })).id;
    for (let i = 1; i <= 6; i++) {
      const number = `${5500 + i}P`;
      const id = (await call(request, "post", "/api/teams", { number, name: `Picker ${i}` })).id;
      teams.push(id);
      numberOf[id] = number;
      await call(request, "post", `/api/sessions/${session}/participants`, { team_id: id, checked_in: true });
    }
    const plan: [number[], number[], number, number][] = [
      [[0, 1], [2, 3], 9, 3],
      [[4, 5], [0, 2], 4, 7],
      [[1, 3], [4, 5], 6, 2],
    ];
    for (const [index, [red, blue, redBalls, blueBalls]] of plan.entries()) {
      const match = (await call(request, "post", "/api/matches", {
        session_id: session,
        round_type: "qualification",
        match_number: index + 1,
        field_id: field,
        alliances: [
          { station: "red", team_ids: red.map((i) => teams[i]) },
          { station: "blue", team_ids: blue.map((i) => teams[i]) },
        ],
      })) as MatchInfo;
      for (const alliance of match.alliances) {
        await call(request, "post", `/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          data: { high_balls: alliance.station === "red" ? redBalls : blueBalls, low_balls: 0, auto_winner: "tie" },
        });
      }
    }
    const preview = await call(request, "get", `/api/sessions/${session}/qualification/finalize-preview`);
    const drops = Object.fromEntries(((preview.rows ?? []) as { played: number; suggested: number }[]).map((row) => [String(row.played), row.suggested]));
    await call(request, "post", `/api/sessions/${session}/qualification/finalize`, { drops });
    const rankings = (await call(request, "get", `/api/rankings?session_id=${session}`)) as { team_id: number; rank: number }[];
    expect(rankings).toHaveLength(6);
    R.push("");
    for (const row of [...rankings].sort((a, b) => a.rank - b.rank)) R.push(numberOf[row.team_id]);

    // A scorer tablet in the device app, and an audience TV showing alliance selection.
    const pairedTablet = await pairBrowser(browser, request, "scorer", "Picking Tablet", { width: 1024, height: 768 });
    tablet = pairedTablet.page;
    await expect(tablet.getByText("Picking Tablet")).toBeVisible({ timeout: 15_000 });
    const pairedTv = await pairBrowser(browser, request, "display_device", "Stage TV", { width: 1920, height: 1080 });
    tv = pairedTv.page;
    await expect(tv.getByText("Stage TV")).toBeVisible({ timeout: 15_000 });
    const groups = (await call(request, "get", `/api/displays?session_id=${session}`)).groups as { id: number; kind: string; field_set_id: number | null }[];
    const audience = groups.find((group) => group.kind === "audience" && group.field_set_id === fieldSet)!;
    await call(request, "patch", `/api/displays/groups/${audience.id}`, { screen: "alliance_selection" });
    await call(request, "put", "/api/displays/assignments", { session_id: session, device_id: pairedTv.id, group_id: audience.id });
    await expect(tv.getByText("Alliance selection hasn't started")).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(() => server?.stop());

  test("the admin starts picking for 4 teams and the tablet and TV switch to it", async ({ browser }) => {
    admin = await (await browser.newContext()).newPage();
    await admin.goto(`${server.baseUrl}/sessions/${session}/finals`);
    await admin.getByLabel("Role").fill("admin");
    await admin.getByLabel("Password").fill(PASSWORD);
    await admin.getByRole("button", { name: "Log in" }).click();
    await expect(admin.getByRole("table", { name: "Rankings for finals" })).toBeVisible({ timeout: 15_000 });
    await admin.getByLabel("Teams in finals").fill("4");
    await expect(admin.getByText("2 alliances")).toBeVisible();
    await admin.getByRole("button", { name: "Start alliance selection" }).click();

    await expect(adminAlliances().locator("tbody tr")).toHaveCount(2, { timeout: 15_000 });
    await expect(adminAllianceRow(1)).toContainText(R[1]);
    await expect(adminAllianceRow(1)).toHaveAttribute("aria-current", "true");

    await expect(tablet.getByTestId("picking-screen")).toBeVisible({ timeout: 15_000 });
    await expect(tablet.getByText("Alliance 1 · Captain")).toBeVisible();
    await expect(tablet.getByTestId("captain-number")).toHaveText(R[1]);
    await expect(tv.getByTestId("alliance-row-1")).toContainText(R[1], { timeout: 15_000 });
    await expect(tv.getByTestId("alliance-row-2")).toBeVisible();
  });

  test("a tablet invite shows as pending on the TV, survives a tablet reload, and a decline strikes the team through", async ({}, testInfo) => {
    await tablet.getByTestId(`pick-team-${R[3]}`).click();
    const pending = tv.getByTestId("pending-invite");
    await expect(pending).toHaveText(`${R[1]} invites ${R[3]}…`, { timeout: 15_000 });
    await expect(tv.getByTestId("alliance-row-1")).toHaveClass(/is-pending/);
    // Amber: the invite banner and the pending partner share the "soon" colour.
    const amber = await tv.getByTestId("alliance-row-1").locator(".alliance-row__partner").evaluate((el) => getComputedStyle(el).color);
    expect(amber).not.toBe("rgba(0, 0, 0, 0)");
    await expect(pending).toHaveCSS("background-color", amber);
    await expect(tv.getByTestId(`available-team-${R[3]}`)).toHaveClass(/is-pending/);
    await expect(adminAllianceRow(1)).toContainText("invited, waiting…");

    const tvIds = ["pending-invite", "alliance-row-1", "alliance-row-2", ...[2, 3, 4, 5, 6].map((rank) => `available-team-${R[rank]}`)];
    await expectFits(tv, tvIds);
    await shot(tv, testInfo, "alliance-selection-pending-1920x1080");
    await tv.setViewportSize({ width: 1280, height: 720 });
    await expectFits(tv, tvIds);
    await shot(tv, testInfo, "alliance-selection-pending-1280x720");
    await tv.setViewportSize({ width: 1920, height: 1080 });

    await tablet.reload();
    await expect(tablet.getByTestId("invitee-number")).toHaveText(R[3], { timeout: 15_000 });
    await expect(tablet.getByTestId("accept-invite")).toBeVisible();
    await expect(tablet.getByTestId("decline-invite")).toBeVisible();

    await tablet.getByTestId("decline-invite").click();
    const declined = tv.getByTestId(`available-team-${R[3]}`);
    await expect(declined).toHaveClass(/is-declined/, { timeout: 15_000 });
    await expect(declined).toHaveCSS("text-decoration-line", "line-through");
    await expect(tv.getByTestId("pending-invite")).toHaveCount(0);
    await expect(tablet.getByTestId(`pick-team-${R[3]}`)).toBeDisabled();
    await expect(tablet.getByTestId(`pick-team-${R[3]}`)).toHaveClass(/is-declined/);
    await expect(adminInvitable().getByRole("listitem").filter({ hasText: R[3] })).toHaveClass(/finals-picking__declined/);
    await expect(admin.getByText(`last: ${R[3]} Picker`)).toBeVisible();
  });

  test("the admin invites and accepts on a team's behalf, undoes it, and does it again", async () => {
    await adminInvitable().getByRole("listitem").filter({ hasText: R[4] }).getByRole("button", { name: "Invite" }).click();
    await expect(adminAllianceRow(1)).toContainText("invited, waiting…");
    await expect(tablet.getByTestId("invitee-number")).toHaveText(R[4], { timeout: 15_000 });
    await admin.getByRole("button", { name: "Accept", exact: true }).click();

    await expect(adminAllianceRow(1)).toContainText(R[1]);
    await expect(adminAllianceRow(1)).toContainText(R[4]);
    await expect(adminAllianceRow(2)).toHaveAttribute("aria-current", "true");
    await expect(adminAllianceRow(2)).toContainText(R[2]);
    await expect(tablet.getByText("Alliance 2 · Captain")).toBeVisible({ timeout: 15_000 });
    await expect(tablet.getByTestId("captain-number")).toHaveText(R[2]);
    await expect(tablet.getByTestId(`pick-team-${R[4]}`)).toHaveCount(0);
    await expect(tv.getByTestId("alliance-row-1")).toContainText(R[1]);
    await expect(tv.getByTestId("alliance-row-1")).toContainText(R[4], { timeout: 15_000 });

    await admin.getByRole("button", { name: "Undo last step" }).click();
    await expect(adminAllianceRow(1)).not.toContainText(R[4]);
    await expect(adminAllianceRow(1)).toHaveAttribute("aria-current", "true");
    await expect(tablet.getByText("Alliance 1 · Captain")).toBeVisible({ timeout: 15_000 });
    await expect(tablet.getByTestId("captain-number")).toHaveText(R[1]);
    await expect(tablet.getByTestId(`pick-team-${R[4]}`)).toBeEnabled();
    await expect(tv.getByTestId("alliance-row-1")).not.toContainText(R[4], { timeout: 15_000 });
    // The decline before it still stands.
    await expect(tv.getByTestId(`available-team-${R[3]}`)).toHaveClass(/is-declined/);

    await adminInvitable().getByRole("listitem").filter({ hasText: R[4] }).getByRole("button", { name: "Invite" }).click();
    await expect(adminAllianceRow(1)).toContainText("invited, waiting…");
    await admin.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(adminAllianceRow(1)).toContainText(R[4]);
    await expect(tablet.getByTestId("captain-number")).toHaveText(R[2], { timeout: 15_000 });
    await expect(tv.getByTestId("alliance-row-1")).toContainText(R[4], { timeout: 15_000 });
  });

  test("the second captain invites from the tablet and accepts; picking ends everywhere", async ({}, testInfo) => {
    await tablet.getByTestId(`pick-team-${R[5]}`).click();
    await expect(tablet.getByTestId("invitee-number")).toHaveText(R[5], { timeout: 15_000 });
    await expect(tv.getByTestId("pending-invite")).toHaveText(`${R[2]} invites ${R[5]}…`, { timeout: 15_000 });
    await tablet.getByTestId("accept-invite").click();

    await expect(tablet.getByTestId("picking-screen")).toHaveCount(0, { timeout: 15_000 });
    await expect(tablet.getByText("Paired as")).toBeVisible();
    await expect(tablet.getByText("Picking Tablet")).toBeVisible();

    await expect(admin.getByText("Finals are in progress.")).toBeVisible({ timeout: 15_000 });
    const progress = admin.getByRole("table", { name: "Alliances in finals" });
    await expect(progress.locator("tbody tr")).toHaveCount(2);
    await expect(progress.locator("tbody tr").nth(0)).toContainText(`${R[1]} Picker`);
    await expect(progress.locator("tbody tr").nth(0)).toContainText(R[4]);
    await expect(progress.locator("tbody tr").nth(1)).toContainText(R[2]);
    await expect(progress.locator("tbody tr").nth(1)).toContainText(R[5]);

    await expect(tv.getByTestId("pending-invite")).toHaveCount(0, { timeout: 15_000 });
    for (const [row, captain, partner] of [[1, R[1], R[4]], [2, R[2], R[5]]] as const) {
      await expect(tv.getByTestId(`alliance-row-${row}`)).toContainText(captain);
      await expect(tv.getByTestId(`alliance-row-${row}`)).toContainText(partner);
      await expect(tv.getByTestId(`alliance-row-${row}`)).not.toContainText("?");
    }
    await expectFits(tv, ["alliance-row-1", "alliance-row-2"]);
    await shot(tv, testInfo, "alliance-selection-done-1920x1080");
    await tv.setViewportSize({ width: 1280, height: 720 });
    await expectFits(tv, ["alliance-row-1", "alliance-row-2"]);
    await shot(tv, testInfo, "alliance-selection-done-1280x720");
  });
});
