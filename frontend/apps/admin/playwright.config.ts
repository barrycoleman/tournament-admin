import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// package.json sets "type": "module", so Playwright loads this file as
// native ESM — __dirname isn't available there, unlike in the Vite/Vitest
// configs (which bundle their config file to CJS before executing it).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND_PORT = 8123;
const FRONTEND_PORT = 5183;

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `tournament-admin-e2e-${Date.now()}.db`
);
const TEST_PLUGINS_ROOT = path.join(
  os.tmpdir(),
  `tournament-admin-e2e-plugins-${Date.now()}`
);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  webServer: [
    {
      command: `.venv/bin/python -m tournament_server.main`,
      cwd: path.resolve(__dirname, "../../../server"),
      env: {
        TOURNAMENT_DB_PATH: TEST_DB_PATH,
        TOURNAMENT_PLUGINS_ROOT: TEST_PLUGINS_ROOT,
        TOURNAMENT_HOST: "127.0.0.1",
        TOURNAMENT_PORT: String(BACKEND_PORT),
      },
      port: BACKEND_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      cwd: __dirname,
      env: {
        VITE_BACKEND_PORT: String(BACKEND_PORT),
      },
      port: FRONTEND_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    // Use the machine's installed Google Chrome rather than Playwright's
    // own managed Chromium download. `npx playwright install` fetches a
    // multi-hundred-MB browser build from cdn.playwright.dev on every
    // fresh machine/CI image, which stalls or times out on restricted
    // networks (confirmed in this project's own dev sandbox) even though
    // small requests to the same host succeed. Requires Google Chrome to
    // be installed on whatever machine runs this suite — see
    // frontend/CLAUDE.md's "Running the E2E suite" section.
    channel: "chrome",
  },
});
