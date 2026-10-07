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

function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
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
  for (const [label, port] of [["backend", backendPort], ["frontend", frontendPort]] as const) {
    if (await portInUse(port, "127.0.0.1")) {
      throw new Error(
        `Isolated E2E ${label} port ${port} is already accepting connections; stop the leftover process before running the suite.`
      );
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "tournament-admin-isolated-e2e-"));
  const backendEnv = { ...process.env };
  delete backendEnv.TOURNAMENT_DEFAULT_DIR;
  const spawned: ChildProcess[] = [];
  const stopAll = () => {
    for (const proc of spawned) {
      if (!proc.pid) continue;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill();
      }
    }
  };
  try {
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
    spawned.push(backend);
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
    spawned.push(frontend);
    await waitForPort(frontendPort, "127.0.0.1", 30_000);
  } catch (error) {
    stopAll();
    throw error;
  }

  return {
    baseUrl: `http://127.0.0.1:${frontendPort}`,
    apiUrl: `http://127.0.0.1:${backendPort}`,
    stop: stopAll,
  };
}
