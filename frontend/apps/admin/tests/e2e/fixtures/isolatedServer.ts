import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module" (see playwright.config.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IsolatedServer {
  baseUrl: string;
  apiUrl: string;
  stop: () => void;
}

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
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

/**
 * A backend on its own fresh database plus a Vite dev server proxying to it,
 * for scenarios the shared E2E event can't host (its game plugin is fixed
 * once chosen). Spawned like tournamentPicker.spec.ts's servers: no shell,
 * and each process leads its own group so stop() reaps the whole tree.
 */
export async function startIsolatedServer({
  backendPort,
  frontendPort,
}: {
  backendPort: number;
  frontendPort: number;
}): Promise<IsolatedServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "tournament-admin-isolated-e2e-"));
  const backendEnv = { ...process.env };
  delete backendEnv.TOURNAMENT_DEFAULT_DIR;
  const backend: ChildProcess = spawn(".venv/bin/python", ["-m", "tournament_server.main"], {
    cwd: path.resolve(__dirname, "../../../../../../server"),
    env: {
      ...backendEnv,
      TOURNAMENT_DB_PATH: path.join(dir, "event.db"),
      TOURNAMENT_CONFIG_PATH: path.join(dir, "server-config.json"),
      TOURNAMENT_PLUGINS_ROOT: path.join(dir, "plugins"),
      TOURNAMENT_HOST: "127.0.0.1",
      TOURNAMENT_PORT: String(backendPort),
    },
    stdio: "ignore",
    detached: true,
  });
  await waitForPort(backendPort, "127.0.0.1", 30_000);

  const frontend: ChildProcess = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(frontendPort), "--strictPort"],
    {
      cwd: path.resolve(__dirname, "../../.."),
      env: { ...process.env, VITE_BACKEND_PORT: String(backendPort) },
      stdio: "ignore",
      detached: true,
    }
  );
  await waitForPort(frontendPort, "127.0.0.1", 30_000);

  return {
    baseUrl: `http://127.0.0.1:${frontendPort}`,
    apiUrl: `http://127.0.0.1:${backendPort}`,
    stop: () => {
      for (const proc of [backend, frontend]) {
        if (!proc.pid) continue;
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          proc.kill();
        }
      }
    },
  };
}
