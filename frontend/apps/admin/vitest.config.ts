import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tournament-admin/shared": path.resolve(
        __dirname,
        "../../packages/shared/src"
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Playwright specs under tests/e2e are run via `playwright test`, not
    // Vitest — exclude them so Vitest's default *.spec.ts glob doesn't try
    // (and fail) to execute them as unit tests.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
