import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.VITE_BACKEND_PORT ?? "8000";
  const devicePort = env.VITE_DEVICE_PORT ?? "5175";
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
        // The device app's dev server (base /device/), so in development, as
        // in production, both apps share one origin. Anchored with the
        // trailing slash: a plain "/device" prefix would also catch the
        // admin's own /devices page.
        "^/device/": { target: `http://127.0.0.1:${devicePort}`, ws: true },
        "^/pair/?$": { target: `http://127.0.0.1:${devicePort}`, rewrite: () => "/device/" },
      },
    },
  };
});
