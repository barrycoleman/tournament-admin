import { test, expect, type Locator, type Page } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("randomize unassigned teams", () => {
  let accessToken = "";
  let divisionIds: number[] = [];

  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const body = await loginResponse.json();
    accessToken = body.access_token as string;

    // These two divisions exist so the Teams grid renders a "Division"
    // column (see the column-index-7 comment below) -- they are not the
    // full set of divisions this test needs to accept, since event
    // creation also auto-seeds a "Division 1" (see divisionIds below).
    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division One" },
    });
    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division Two" },
    });

    // The balanced-assignment algorithm can legitimately place a
    // randomly-assigned team into ANY of the event's divisions,
    // including the auto-seeded default one -- so divisionIds must be
    // the full current division list, not just the two created above.
    const allDivisionsResponse = await request.get("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const allDivisions = await allDivisionsResponse.json();
    divisionIds = allDivisions.map((d: { id: number }) => d.id);

    await request.post("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { number: "7001A", name: "Unassigned Team" },
    });
  });

  test("clicking the button assigns previously-unassigned teams", async ({ page, request }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Randomly assign unassigned teams" }).click();

    await expect
      .poll(async () => {
        const teamsResponse = await request.get("/api/teams", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const teams = await teamsResponse.json();
        const team = teams.find((t: { number: string }) => t.number === "7001A");
        return team?.division_id ?? null;
      })
      .not.toBeNull();
  });

  test("selecting (random) for a new row's division assigns it a real division on save", async ({
    page,
    request,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Add row" }).click();

    const row = page.getByRole("row").last();
    await row.getByRole("gridcell").nth(0).dblclick();
    await page.getByRole("textbox").fill("8501A");
    await page.keyboard.press("Tab");
    await row.getByRole("gridcell").nth(1).dblclick();
    await page.getByRole("textbox").fill("Random Division Team");
    await page.keyboard.press("Tab");

    // Division is column index 7 (number, name, robot_name, organization,
    // city, state, country, division) -- present because this describe
    // block's beforeAll creates two divisions, so the grid shows the column.
    await row.getByRole("gridcell").nth(7).dblclick();
    await row.getByRole("combobox").selectOption({ label: "(random)" });
    await expect(row.getByRole("gridcell").nth(7)).toHaveText("(random)");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("1 saved");
    await expect(page.getByText("Random Division Team")).toBeVisible();

    await expect
      .poll(async () => {
        const teamsResponse = await request.get("/api/teams", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const teams = await teamsResponse.json();
        const team = teams.find((t: { number: string }) => t.number === "8501A");
        return team?.division_id ?? null;
      })
      .not.toBeNull();

    const teamsResponse = await request.get("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const teams = await teamsResponse.json();
    const team = teams.find((t: { number: string }) => t.number === "8501A");
    expect(divisionIds).toContain(team.division_id);
  });

  // Columns are sized from their data: team numbers stay whole, division
  // names keep enough to tell them apart, empty columns shrink to their
  // header, and the rest of the width goes to columns that have data.
  test.describe("column widths", () => {
    test.beforeAll(async ({ request }) => {
      const divisionsResponse = await request.get("/api/divisions", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const divisions: { id: number; name: string }[] = await divisionsResponse.json();
      const divisionTwo = divisions.find((d) => d.name === "Randomize Division Two");
      await request.post("/api/teams", {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { number: "7002A", name: "Long Division Team", division_id: divisionTwo!.id },
      });
    });

    async function openTeams(page: Page) {
      await page.goto("/login");
      await page.getByLabel("Role").fill("admin");
      await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
      await page.getByRole("button", { name: "Log in" }).click();
      await page.getByRole("link", { name: "Teams" }).click();
      await expect(page).toHaveURL(/\/teams$/);
      const row = page.getByRole("row").filter({ hasText: "Long Division Team" });
      await expect(row).toBeVisible();
      return row;
    }

    // How far the cell's text runs past its content box, to the sub-pixel:
    // scrollWidth rounds to whole pixels and hides an overflow small enough
    // to still draw the ellipsis.
    const overflow = (cell: Locator) =>
      cell.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const style = getComputedStyle(el);
        const content =
          el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return range.getBoundingClientRect().width - content;
      });
    const width = (cell: Locator) => cell.evaluate((el) => el.getBoundingClientRect().width);

    test("a wide window shows names in full and gives empty columns less room", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const row = await openTeams(page);
      // number, name, robot_name, organization, city, state, country, division
      const cells = row.getByRole("gridcell");

      // Names that share a long prefix are only distinguishable by their
      // endings, so an ellipsis after the prefix would make them unreadable.
      await expect(cells.nth(7)).toHaveText("Randomize Division Two");
      expect(await overflow(cells.nth(7))).toBeLessThanOrEqual(0);
      expect(await overflow(cells.nth(1))).toBeLessThanOrEqual(0);

      // No team in this event has a robot name: that column keeps just its
      // header, which stays readable, while Name gets more.
      for (const header of ["Robot Name", "Organization", "City", "State", "Country"]) {
        const cell = page.getByRole("columnheader", { name: header, exact: true });
        expect(await overflow(cell), header).toBeLessThanOrEqual(0);
      }
      expect(await width(cells.nth(2))).toBeLessThan(await width(cells.nth(1)));

      // Everything fits, so the grid doesn't scroll sideways.
      const grid = page.getByRole("grid");
      expect(await grid.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    });

    test("a narrow window keeps numbers whole and divisions distinguishable", async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 800 });
      const row = await openTeams(page);
      const cells = row.getByRole("gridcell");

      // The minimums don't fit a phone: the grid scrolls instead of
      // squeezing the columns that identify a team.
      const grid = page.getByRole("grid");
      expect(await grid.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
      expect(await overflow(cells.nth(0))).toBeLessThanOrEqual(0);
      for (const header of ["Number", "Name", "Robot Name", "City"]) {
        const cell = page.getByRole("columnheader", { name: header, exact: true });
        expect(await overflow(cell), header).toBeLessThanOrEqual(0);
      }

      // "Randomize Division One" and "...Two" differ at the "T", so the
      // cell must show at least "Randomize Division T…" -- measured in the
      // cell's own font.
      const division = cells.nth(7);
      await division.scrollIntoViewIfNeeded();
      const fits = await division.evaluate((el) => {
        const style = getComputedStyle(el);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const needed = context.measureText("Randomize Division T…").width;
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        return el.clientWidth - padding >= needed;
      });
      expect(fits).toBe(true);
    });
  });
});
