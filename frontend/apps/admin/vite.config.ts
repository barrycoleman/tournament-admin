import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.VITE_BACKEND_PORT ?? "8000";
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@tournament-admin/shared": path.resolve(
          __dirname,
          "../../packages/shared/src"
        ),
      },
    },
    server: {
      proxy: {
        "/api": `http://127.0.0.1:${backendPort}`,
        "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true },
      },
    },
  };
});
