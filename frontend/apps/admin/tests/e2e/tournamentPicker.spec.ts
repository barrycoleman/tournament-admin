import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module", so this spec file loads as native
// ESM -- __dirname isn't available directly (same reason
// playwright.config.ts computes it this way).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ISOLATED_BACKEND_PORT = 8124;
const ISOLATED_FRONTEND_PORT = 5184;
const BASE_URL = `http://127.0.0.1:${ISOLATED_FRONTEND_PORT}`;

function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

test.describe.serial("tournament picker: fresh server bootstrap", () => {
  test.describe.configure({ timeout: 90_000 });

  let backendProcess: ChildProcess;
  let frontendProcess: ChildProcess;
  let tournamentDir: string;

  test.beforeAll(async () => {
    tournamentDir = mkdtempSync(path.join(tmpdir(), "tournament-admin-picker-e2e-"));
    const configPath = path.join(tournamentDir, "server-config.json");

    const serverRoot = path.resolve(__dirname, "../../../../../server");
    // No `shell: true` here (unlike the brief's original draft): with
    // shell:true, Node runs `/bin/sh -c '.venv/bin/python ...'`, and on
    // this project's dev sandbox that does NOT exec-replace the shell --
    // it forks, so the tracked ChildProcess's pid is the *shell*, not the
    // actual python/uvicorn process. Killing that pid in afterAll only
    // kills the already-exited shell, leaking the real server process
    // (still bound to ISOLATED_BACKEND_PORT) for the lifetime of the host
    // machine. `.venv/bin/python` is a real executable and doesn't need a
    // shell to resolve, so spawning it directly avoids the problem
    // entirely. `detached: true` puts it in its own process group (see
    // the frontend spawn below for why that matters generally); combined
    // with the direct, unwrapped exec here, `backendProcess.pid` is
    // reliably the actual server process either way.
    // A developer with TOURNAMENT_DB_PATH or TOURNAMENT_DEFAULT_DIR
    // exported in their own shell would otherwise leak it into this
    // isolated backend, which would then boot in normal mode (or with an
    // unexpected pre-seeded allowlist) instead of fresh picker mode --
    // producing a confusing first-assertion failure. Matches the same
    // env.pop(...) pattern test_main.py's subprocess tests already use.
    const backendEnv = { ...process.env };
    delete backendEnv.TOURNAMENT_DB_PATH;
    delete backendEnv.TOURNAMENT_DEFAULT_DIR;

    backendProcess = spawn(".venv/bin/python", ["-m", "tournament_server.main"], {
      cwd: serverRoot,
      env: {
        ...backendEnv,
        TOURNAMENT_CONFIG_PATH: configPath,
        TOURNAMENT_PLUGINS_ROOT: path.join(tournamentDir, "plugins"),
        TOURNAMENT_HOST: "127.0.0.1",
        TOURNAMENT_PORT: String(ISOLATED_BACKEND_PORT),
      },
      stdio: "pipe",
      detached: true,
    });
    await waitForPort(ISOLATED_BACKEND_PORT, "127.0.0.1", 30_000);

    const adminAppRoot = path.resolve(__dirname, "../../");
    // Same reasoning as above, plus one more layer: `npm run dev` itself
    // forks a `node` process to run Vite, which can in turn spawn its own
    // helper processes -- killing only the top-level npm pid (however it
    // was spawned) does not reap that whole tree. `detached: true` puts
    // this process in its own new process group (as its leader), so
    // `process.kill(-frontendProcess.pid!, ...)` in afterAll signals the
    // entire group at once rather than just the one pid.
    frontendProcess = spawn(
      "npm",
      ["run", "dev", "--", "--port", String(ISOLATED_FRONTEND_PORT), "--strictPort"],
      {
        cwd: adminAppRoot,
        env: { ...process.env, VITE_BACKEND_PORT: String(ISOLATED_BACKEND_PORT) },
        stdio: "pipe",
        detached: true,
      }
    );
    await waitForPort(ISOLATED_FRONTEND_PORT, "127.0.0.1", 30_000);
  });

  test.afterAll(() => {
    // Negative pid = signal the whole process group (see the `detached:
    // true` comments in beforeAll) -- not just the single tracked pid,
    // which for the frontend in particular is only the top of a small
    // process tree.
    for (const proc of [backendProcess, frontendProcess]) {
      if (!proc?.pid) continue;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill();
      }
    }
  });

  test("creating a new tournament restarts the server into the event-setup flow", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole("heading", { name: "Start a tournament" })).toBeVisible();

    await page.getByRole("button", { name: "Create New Tournament" }).click();
    await page.getByRole("button", { name: "Add a directory..." }).click();
    await page.getByLabel("New directory path").fill(tournamentDir);
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // The newly added directory's <option> value is the server's own
    // resolved (canonical) path -- on this project's Linux dev sandbox,
    // an mkdtemp()'d path under the system temp directory already
    // resolves to itself, so the exact string typed above is also the
    // option's value.
    await page.getByLabel("Directory", { exact: true }).selectOption(tournamentDir);
    await page.getByLabel("Filename").fill("e2e-created.db");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // The backend process restarts itself (os.execve) after this
    // request -- give the reconnect poll (15s timeout, see
    // useRestartPoll.ts) room to see the new process come up.
    await expect(page.getByRole("heading", { name: "Set up your event" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("switching tournaments from the running app returns to the picker", async ({ page }) => {
    await page.goto(`${BASE_URL}/events/new`);
    await page.getByLabel("Event name").fill("Picker E2E Event");
    await page.getByLabel(/Initial password/).fill("picker-e2e-pw");
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("picker-e2e-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(BASE_URL + "/");

    await page.getByRole("button", { name: "Switch Tournament" }).click();
    await expect(page.getByRole("heading", { name: "Start a tournament" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("the filename field defaults to a timestamp, sanitizes spaces, and gets .db appended automatically", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole("heading", { name: "Start a tournament" })).toBeVisible();

    await page.getByRole("button", { name: "Create New Tournament" }).click();

    const filenameInput = page.getByLabel("Filename");
    await expect(filenameInput).toHaveValue(/^\d{8}T\d{4}-tournament\.db$/);

    await page.getByLabel("Directory", { exact: true }).selectOption(tournamentDir);
    await filenameInput.fill("my second tournament");
    await expect(filenameInput).toHaveValue("my_second_tournament");

    await page.getByRole("button", { name: "Create", exact: true }).click();

    // No .db in what was typed -- the client appends it before submitting,
    // so this must succeed exactly like a fully-typed ".db" filename would.
    await expect(page.getByRole("heading", { name: "Set up your event" })).toBeVisible({
      timeout: 20_000,
    });
  });
});
