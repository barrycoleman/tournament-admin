// Runs on the shared E2E event; the zzz_ prefix makes it run after zz_seasonRankings, whose season assertions it would otherwise disturb.
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

test("head-to-head finalize asks only for confirmation", async ({ page, request }) => {
  // Create-or-tolerate-409 so the spec can also run standalone.
  const created = await request.post("/api/event", { data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD } });
  expect([201, 409]).toContain(created.status());
  const token = (await (await request.post("/api/auth/login", { data: { role: "admin", password: E2E_EVENT_PASSWORD } })).json())
    .access_token;
  const headers = { Authorization: `Bearer ${token}` };
  const event = await (await request.get("/api/event")).json();
  if (event.game_plugin_name === null) {
    const uploaded = await request.post("/api/plugins/games", {
      headers,
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildExampleGamePluginZip()) },
      },
    });
    expect([201, 409]).toContain(uploaded.status());
    expect((await request.post("/api/event/game-plugin", { headers, data: { name: "example-game" } })).ok()).toBeTruthy();
  }
  const ids: number[] = [];
  for (const number of ["HF1", "HF2"]) {
    ids.push((await (await request.post("/api/teams", { headers, data: { number, name: `Head ${number}` } })).json()).id);
  }
  const session = (await (await request.post("/api/sessions", { headers, data: { label: "Finalize H2H" } })).json()).id;
  for (const number of [1, 2]) {
    const match = await (
      await request.post("/api/matches", {
        headers,
        data: {
          session_id: session, round_type: "qualification", match_number: number, field_id: null,
          alliances: [{ station: "red", team_ids: [ids[0]] }, { station: "blue", team_ids: [ids[1]] }],
        },
      })
    ).json();
    if (number === 1) {
      for (const alliance of match.alliances) {
        await request.post(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          headers,
          data: { data: { high_balls: alliance.station === "red" ? 5 : 2, low_balls: 0, auto_winner: "tie" } },
        });
      }
    }
  }

  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
  await page.goto(`/sessions/${session}/matches`);
  await page.getByRole("button", { name: "Finalize qualification" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Finalize qualification" });
  await expect(dialog.getByText("Rankings will use the matches played so far.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Finalize", exact: true }).click();
  await expect(page.getByText(/^Qualification finalized on/)).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "Not played" })).toHaveCount(1);
});
