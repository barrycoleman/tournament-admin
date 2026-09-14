# Admin UI Shell & Event/Plugin Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working admin web app (login, app shell, event bootstrap, plugin install/selection, role passwords, LAN QR display, a live-events debug panel) built to static assets served by the existing FastAPI server, plus a shared auth/API-client/i18n/realtime package the future scorer UI will reuse.

**Architecture:** An npm workspace (`frontend/`) with `apps/admin` (Vite + React + TypeScript, React Router data router, TanStack Query) and `packages/shared` (framework-agnostic-ish auth/token/API-client/i18n/realtime modules, consumed by source via a Vite/TS path alias — no build step of its own). The backend gains a static-file mount + SPA-fallback route so the built app is served from the same process and port as the API.

**Tech Stack:** TypeScript, React 18, Vite 5, React Router 6 (data routers), TanStack Query 5, react-i18next, Vitest + React Testing Library (unit), Playwright (E2E, against a real FastAPI test server and a real Vite dev server — no mocking at the HTTP/WebSocket boundary).

**Spec:** `docs/superpowers/specs/2026-09-14-admin-ui-shell-design.md`

## Global Constraints

- Language: TypeScript everywhere in `frontend/`.
- Both the access token and the rotating refresh token live in `localStorage`; a silent background refresh fires 30 seconds before `expires_in` elapses, and `api-client` reactively refreshes-and-retries once on any `401`.
- Explicit logout MUST call `POST /api/auth/logout` (server-side revocation) before clearing `localStorage`, even if that call fails (local state is always cleared).
- Page/route gating is bearer-token-only, client-side — the built static assets are served unauthenticated; there is no session cookie.
- `POST /api/event` and `GET /api/event` are unauthenticated on the backend. The "is an event configured yet" check MUST happen before any token/login check — never nested inside an authenticated layout (see spec's "Routing & guards" section for why).
- Every user-facing string goes through `react-i18next`'s `useTranslation()` from the moment it's written, with both an `en` and a `zh` entry added in the same task — never deferred.
- WCAG 2.1 AA: semantic landmarks (`<header>`, `<nav>`, `<main>`), every form field has an associated `<label>` and `aria-describedby` error text, visible focus states.
- No mocking at the HTTP/WebSocket boundary for integration-level tests: Playwright E2E tests run against a real FastAPI process (via `python -m tournament_server.main`, using the project's `.venv`) and a real Vite dev server, with a fresh temp-file SQLite DB per test run.
- `packages/shared` has no build step — `apps/admin` resolves it directly from TypeScript source via a Vite `resolve.alias` and a matching `tsconfig.json` `paths` entry (not through node_modules package resolution). Do not add a bundler/tsup step for it — that's unnecessary given it has exactly one consumer today.
- Workspace layout: `frontend/apps/admin/` and `frontend/packages/shared/`, per the spec's file tree.

---

### Task 1: Frontend workspace scaffolding

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/apps/admin/package.json`
- Create: `frontend/apps/admin/tsconfig.json`
- Create: `frontend/apps/admin/vite.config.ts`
- Create: `frontend/apps/admin/vitest.config.ts`
- Create: `frontend/apps/admin/vitest.setup.ts`
- Create: `frontend/apps/admin/playwright.config.ts`
- Create: `frontend/apps/admin/index.html`
- Create: `frontend/apps/admin/src/main.tsx`
- Create: `frontend/apps/admin/src/App.tsx`
- Create: `frontend/apps/admin/tests/unit/App.test.tsx`
- Create: `frontend/apps/admin/tests/e2e/smoke.spec.ts`
- Create: `frontend/packages/shared/package.json`
- Create: `frontend/packages/shared/tsconfig.json`
- Create: `frontend/packages/shared/vitest.config.ts`
- Create: `frontend/packages/shared/vitest.setup.ts`
- Create: `frontend/packages/shared/src/index.ts`
- Create: `frontend/packages/shared/tests/setup.smoke.test.tsx`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: the `@tournament-admin/shared` import path (aliased to `frontend/packages/shared/src` in both `apps/admin/vite.config.ts` and `apps/admin/tsconfig.json`), the workspace's build/test/e2e npm scripts, and an empty `index.ts` barrel that Task 2 onward append to.

This task has no backend dependency and no prior task to consume from — it's pure scaffolding. Every later frontend task builds inside the structure created here.

- [ ] **Step 1: Create the workspace root**

`frontend/package.json`:

```json
{
  "name": "tournament-admin-frontend",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

- [ ] **Step 2: Update the repo root `.gitignore`**

Append to `.gitignore`:

```
node_modules/
frontend/apps/*/dist/
frontend/**/test-results/
frontend/**/playwright-report/
```

- [ ] **Step 3: Scaffold `packages/shared`**

`frontend/packages/shared/package.json`:

```json
{
  "name": "@tournament-admin/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "i18next": "^23.15.0",
    "react-i18next": "^15.0.0"
  },
  "peerDependencies": {
    "react": "^18.3.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "jsdom": "^25.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

`frontend/packages/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`frontend/packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

`frontend/packages/shared/vitest.setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`frontend/packages/shared/src/index.ts` (empty barrel for now — appended to by every later shared task):

```ts
export {};
```

- [ ] **Step 4: Write the shared-package smoke test**

`frontend/packages/shared/tests/setup.smoke.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function Greeting() {
  return <p>toolchain ok</p>;
}

describe("shared package test toolchain", () => {
  it("renders with React Testing Library under jsdom", () => {
    render(<Greeting />);
    expect(screen.getByText("toolchain ok")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the shared package's test to verify the toolchain works**

Run (from `frontend/packages/shared/`): `npm install && npm test`
Expected: 1 test passes.

- [ ] **Step 6: Scaffold `apps/admin`**

`frontend/apps/admin/package.json`:

```json
{
  "name": "@tournament-admin/admin",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "@tournament-admin/shared": "*",
    "i18next": "^23.15.0",
    "qrcode": "^1.5.4",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-i18next": "^15.0.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.0",
    "@types/qrcode": "^1.5.5",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "archiver": "^7.0.1",
    "@types/archiver": "^6.0.2",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.2",
    "vite": "^5.4.6",
    "vitest": "^2.1.1"
  }
}
```

`frontend/apps/admin/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "paths": {
      "@tournament-admin/shared": ["../../packages/shared/src/index.ts"],
      "@tournament-admin/shared/*": ["../../packages/shared/src/*"]
    }
  },
  "include": ["src", "tests"]
}
```

`frontend/apps/admin/vite.config.ts`:

```ts
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
```

`frontend/apps/admin/vitest.config.ts`:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";
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
  },
});
```

`frontend/apps/admin/vitest.setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`frontend/apps/admin/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tournament Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/apps/admin/src/App.tsx`:

```tsx
export function App() {
  return <p>Tournament Admin</p>;
}
```

`frontend/apps/admin/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 7: Write the admin app's unit smoke test**

`frontend/apps/admin/tests/unit/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";

describe("App", () => {
  it("renders the placeholder heading", () => {
    render(<App />);
    expect(screen.getByText("Tournament Admin")).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Write the Playwright config**

`frontend/apps/admin/playwright.config.ts`:

```ts
import path from "node:path";
import os from "node:os";
import { defineConfig } from "@playwright/test";

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
  },
});
```

Note for whoever runs this: the backend port (8123) is fixed rather than probed, because `python -m tournament_server.main` can silently rebind to a nearby free port if 8123 is busy (see `network.find_free_port`), which would break Playwright's port-based readiness wait. This is a known, accepted limitation — pick a different `BACKEND_PORT`/`FRONTEND_PORT` pair if either is already in use on the machine running the tests.

- [ ] **Step 9: Write the E2E smoke test**

`frontend/apps/admin/tests/e2e/smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("the app loads and the backend is reachable through the dev proxy", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Tournament Admin")).toBeVisible();

  const response = await page.request.get("/api/event");
  // No event exists yet in this fresh temp DB.
  expect(response.status()).toBe(404);
});
```

- [ ] **Step 10: Install dependencies and verify everything wired**

Run (from `frontend/`): `npm install`
Run (from `frontend/apps/admin/`): `npm test`
Expected: 1 test passes.

Run (from `frontend/apps/admin/`): `npx playwright install --with-deps chromium` (skip `--with-deps` if system deps are already present), then `npm run test:e2e`
Expected: 1 test passes, proving the backend process, the Vite dev server, and the dev proxy all work together.

Run (from `frontend/apps/admin/`): `npm run build`
Expected: succeeds, producing `frontend/apps/admin/dist/index.html` and `dist/assets/`.

- [ ] **Step 11: Commit**

```bash
git add frontend .gitignore
git commit -m "Scaffold frontend workspace: apps/admin + packages/shared"
```

---

### Task 2: `shared/tokenStorage` and `shared/jwt`

**Files:**
- Create: `frontend/packages/shared/src/tokenStorage.ts`
- Create: `frontend/packages/shared/src/jwt.ts`
- Create: `frontend/packages/shared/tests/tokenStorage.test.ts`
- Create: `frontend/packages/shared/tests/jwt.test.ts`
- Modify: `frontend/packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `interface StoredTokens { accessToken: string; refreshToken: string; expiresAt: number }`
  - `getStoredTokens(): StoredTokens | null`
  - `storeTokens(tokens: StoredTokens): void`
  - `clearStoredTokens(): void`
  - `tokensFromLoginResponse(response: { access_token: string; refresh_token: string; expires_in: number }): StoredTokens`
  - `interface AccessTokenPayload { role: string; iat: number; exp: number }`
  - `decodeAccessTokenPayload(accessToken: string): AccessTokenPayload`

These are pure functions (no `fetch`, no React) — every later shared module builds on them.

- [ ] **Step 1: Write the failing tokenStorage tests**

`frontend/packages/shared/tests/tokenStorage.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredTokens,
  getStoredTokens,
  storeTokens,
  tokensFromLoginResponse,
} from "../src/tokenStorage";

beforeEach(() => {
  localStorage.clear();
});

describe("tokenStorage", () => {
  it("returns null when nothing is stored", () => {
    expect(getStoredTokens()).toBeNull();
  });

  it("round-trips stored tokens", () => {
    storeTokens({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
    expect(getStoredTokens()).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 123,
    });
  });

  it("clears stored tokens", () => {
    storeTokens({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
    clearStoredTokens();
    expect(getStoredTokens()).toBeNull();
  });

  it("returns null for malformed stored JSON rather than throwing", () => {
    localStorage.setItem("tournament-admin.auth.v1", "{not json");
    expect(getStoredTokens()).toBeNull();
  });

  it("returns null when the stored shape is missing fields", () => {
    localStorage.setItem(
      "tournament-admin.auth.v1",
      JSON.stringify({ accessToken: "a" })
    );
    expect(getStoredTokens()).toBeNull();
  });
});

describe("tokensFromLoginResponse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes expiresAt from the current time plus expires_in seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const result = tokensFromLoginResponse({
      access_token: "a",
      refresh_token: "r",
      expires_in: 1800,
    });
    expect(result).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date("2026-01-01T00:30:00.000Z").getTime(),
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/tokenStorage.test.ts`
Expected: FAIL — `../src/tokenStorage` does not exist.

- [ ] **Step 3: Implement tokenStorage**

`frontend/packages/shared/src/tokenStorage.ts`:

```ts
const STORAGE_KEY = "tournament-admin.auth.v1";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface LoginOrRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

export function getStoredTokens(): StoredTokens | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeTokens(tokens: StoredTokens): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function clearStoredTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function tokensFromLoginResponse(
  response: LoginOrRefreshResponse
): StoredTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
}
```

- [ ] **Step 4: Run the tokenStorage tests to verify they pass**

Run: `cd frontend/packages/shared && npx vitest run tests/tokenStorage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing jwt test**

`frontend/packages/shared/tests/jwt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeAccessTokenPayload } from "../src/jwt";

function base64url(input: object): string {
  const json = JSON.stringify(input);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJwt(payload: object): string {
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const body = base64url(payload);
  // Decoding never verifies the signature client-side, so any
  // third segment is fine for this test.
  return `${header}.${body}.unsigned`;
}

describe("decodeAccessTokenPayload", () => {
  it("decodes the role, iat, and exp claims without verifying the signature", () => {
    const token = fakeJwt({ role: "admin", iat: 1000, exp: 2800 });
    expect(decodeAccessTokenPayload(token)).toEqual({
      role: "admin",
      iat: 1000,
      exp: 2800,
    });
  });

  it("throws on a malformed token", () => {
    expect(() => decodeAccessTokenPayload("not-a-jwt")).toThrow();
  });
});
```

- [ ] **Step 6: Run the jwt test to verify it fails**

Run: `cd frontend/packages/shared && npx vitest run tests/jwt.test.ts`
Expected: FAIL — `../src/jwt` does not exist.

- [ ] **Step 7: Implement jwt decoding**

`frontend/packages/shared/src/jwt.ts`:

```ts
export interface AccessTokenPayload {
  role: string;
  iat: number;
  exp: number;
}

/**
 * Decodes (without verifying) the payload of a JWT access token, purely
 * for client-side display (e.g. showing the current role in the UI).
 * The server is the only party that verifies the signature; every
 * real request is independently bearer-token and role gated there.
 */
export function decodeAccessTokenPayload(accessToken: string): AccessTokenPayload {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed access token");
  }
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const json = atob(padded);
  return JSON.parse(json) as AccessTokenPayload;
}
```

- [ ] **Step 8: Run the jwt tests to verify they pass**

Run: `cd frontend/packages/shared && npx vitest run tests/jwt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Export from the barrel**

`frontend/packages/shared/src/index.ts`:

```ts
export * from "./tokenStorage";
export * from "./jwt";
```

- [ ] **Step 10: Run the full shared test suite**

Run: `cd frontend/packages/shared && npm test`
Expected: all tests pass (8 total, including Task 1's smoke test).

- [ ] **Step 11: Commit**

```bash
git add frontend/packages/shared
git commit -m "Add shared tokenStorage and JWT payload decoding"
```

---

### Task 3: `shared/refresh`

**Files:**
- Create: `frontend/packages/shared/src/refresh.ts`
- Create: `frontend/packages/shared/tests/refresh.test.ts`
- Modify: `frontend/packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `getStoredTokens`, `storeTokens`, `clearStoredTokens`, `tokensFromLoginResponse`, `StoredTokens` from `./tokenStorage` (Task 2).
- Produces:
  - `class RefreshError extends Error {}`
  - `refreshTokens(): Promise<StoredTokens>`

This module uses the browser's raw `fetch` directly — never `shared/api-client` (Task 4) — so that a `401` from `/api/auth/refresh` itself can never trigger `api-client`'s own refresh-and-retry logic and recurse.

- [ ] **Step 1: Write the failing tests**

`frontend/packages/shared/tests/refresh.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredTokens, getStoredTokens, storeTokens } from "../src/tokenStorage";
import { RefreshError, refreshTokens } from "../src/refresh";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("refreshTokens", () => {
  it("throws without calling fetch when there is nothing stored", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(refreshTokens()).rejects.toThrow(RefreshError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the stored refresh token and stores the new pair on success", async () => {
    storeTokens({ accessToken: "old-a", refreshToken: "old-r", expiresAt: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-a",
          refresh_token: "new-r",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );

    const result = await refreshTokens();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refresh_token: "old-r" }),
      })
    );
    expect(result.accessToken).toBe("new-a");
    expect(getStoredTokens()?.accessToken).toBe("new-a");
  });

  it("clears storage and throws RefreshError on a non-2xx response", async () => {
    storeTokens({ accessToken: "old-a", refreshToken: "old-r", expiresAt: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid or expired refresh token" }), {
        status: 401,
      })
    );

    await expect(refreshTokens()).rejects.toThrow(RefreshError);
    expect(getStoredTokens()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/refresh.test.ts`
Expected: FAIL — `../src/refresh` does not exist.

- [ ] **Step 3: Implement refresh**

`frontend/packages/shared/src/refresh.ts`:

```ts
import {
  clearStoredTokens,
  getStoredTokens,
  storeTokens,
  tokensFromLoginResponse,
  type StoredTokens,
} from "./tokenStorage";

export class RefreshError extends Error {}

interface RefreshResponseBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Rotates the refresh token: calls POST /api/auth/refresh directly via
 * fetch (never through shared/api-client) so a 401 here can never
 * trigger api-client's own refresh-and-retry loop and recurse.
 */
export async function refreshTokens(): Promise<StoredTokens> {
  const current = getStoredTokens();
  if (!current) {
    throw new RefreshError("No refresh token available");
  }

  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  });

  if (!response.ok) {
    clearStoredTokens();
    throw new RefreshError(`Refresh failed with status ${response.status}`);
  }

  const body = (await response.json()) as RefreshResponseBody;
  const next = tokensFromLoginResponse(body);
  storeTokens(next);
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend/packages/shared && npx vitest run tests/refresh.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export from the barrel**

`frontend/packages/shared/src/index.ts` — add:

```ts
export * from "./refresh";
```

- [ ] **Step 6: Run the full shared test suite and commit**

Run: `cd frontend/packages/shared && npm test`
Expected: all tests pass.

```bash
git add frontend/packages/shared
git commit -m "Add shared refresh-token rotation"
```

---

### Task 4: `shared/api-client`

**Files:**
- Create: `frontend/packages/shared/src/api-client.ts`
- Create: `frontend/packages/shared/tests/api-client.test.ts`
- Modify: `frontend/packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `getStoredTokens` from `./tokenStorage` (Task 2); `refreshTokens`, `RefreshError` from `./refresh` (Task 3).
- Produces:
  - `class ApiError extends Error { status: number; detail: string }`
  - `interface ApiRequestOptions { method?: string; body?: unknown; isFormData?: boolean }`
  - `apiRequest<T>(path: string, options?: ApiRequestOptions): Promise<T>`

- [ ] **Step 1: Write the failing tests**

`frontend/packages/shared/tests/api-client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeTokens } from "../src/tokenStorage";
import { ApiError, apiRequest } from "../src/api-client";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("apiRequest", () => {
  it("attaches the stored bearer token and returns parsed JSON", async () => {
    storeTokens({ accessToken: "token-123", refreshToken: "r", expiresAt: 0 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await apiRequest<{ ok: boolean }>("/api/event");

    expect(result).toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-123"
    );
  });

  it("sends no Authorization header when no tokens are stored", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await apiRequest("/api/event");

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("JSON-encodes a plain body and sets Content-Type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await apiRequest("/api/event", { method: "POST", body: { name: "x" } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("passes a FormData body through untouched, without a Content-Type header", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 201 }));
    const form = new FormData();

    await apiRequest("/api/plugins/games", {
      method: "POST",
      body: form,
      isFormData: true,
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.body).toBe(form);
    expect(
      (init?.headers as Record<string, string>)["Content-Type"]
    ).toBeUndefined();
  });

  it("returns undefined for a 204 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const result = await apiRequest<undefined>("/api/auth/logout", { method: "POST" });
    expect(result).toBeUndefined();
  });

  it("throws ApiError with the response detail on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "nope" }), { status: 409 })
    );

    await expect(apiRequest("/api/event")).rejects.toMatchObject(
      new ApiError(409, "nope")
    );
  });

  it("on a 401, refreshes once and retries, returning the retried result", async () => {
    storeTokens({ accessToken: "stale", refreshToken: "r", expiresAt: 0 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "fresh",
            refresh_token: "fresh-r",
            expires_in: 1800,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await apiRequest<{ ok: boolean }>("/api/event");

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const lastCallHeaders = fetchSpy.mock.calls[2][1]?.headers as Record<string, string>;
    expect(lastCallHeaders.Authorization).toBe("Bearer fresh");
  });

  it("throws ApiError(401, 'Session expired') when the refresh itself fails", async () => {
    storeTokens({ accessToken: "stale", refreshToken: "r", expiresAt: 0 });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(apiRequest("/api/event")).rejects.toMatchObject(
      new ApiError(401, "Session expired")
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/api-client.test.ts`
Expected: FAIL — `../src/api-client` does not exist.

- [ ] **Step 3: Implement the API client**

`frontend/packages/shared/src/api-client.ts`:

```ts
import { getStoredTokens } from "./tokenStorage";
import { RefreshError, refreshTokens } from "./refresh";

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  /** Set true when `body` is already a FormData instance (multipart upload). */
  isFormData?: boolean;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string };
    return body.detail ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function buildHeaders(options: ApiRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  const tokens = getStoredTokens();
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  if (options.body !== undefined && !options.isFormData) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function buildBody(options: ApiRequestOptions): BodyInit | undefined {
  if (options.body === undefined) return undefined;
  return options.isFormData ? (options.body as FormData) : JSON.stringify(options.body);
}

async function doFetch(path: string, options: ApiRequestOptions): Promise<Response> {
  return fetch(path, {
    method: options.method ?? "GET",
    headers: buildHeaders(options),
    body: buildBody(options),
  });
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  let response = await doFetch(path, options);

  if (response.status === 401) {
    try {
      await refreshTokens();
    } catch (err) {
      if (err instanceof RefreshError) {
        throw new ApiError(401, "Session expired");
      }
      throw err;
    }
    response = await doFetch(path, options);
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorDetail(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend/packages/shared && npx vitest run tests/api-client.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Export from the barrel**

`frontend/packages/shared/src/index.ts` — add:

```ts
export * from "./api-client";
```

- [ ] **Step 6: Run the full shared test suite and commit**

Run: `cd frontend/packages/shared && npm test`
Expected: all tests pass.

```bash
git add frontend/packages/shared
git commit -m "Add shared API client with 401-triggered refresh-and-retry"
```

---

### Task 5: `shared/auth` (React auth context)

**Files:**
- Create: `frontend/packages/shared/src/auth.tsx`
- Create: `frontend/packages/shared/tests/auth.test.tsx`
- Modify: `frontend/packages/shared/src/index.ts`
- Modify: `frontend/packages/shared/package.json` (add `@testing-library/react`'s `renderHook` usage needs no new dependency; no change needed beyond what Task 1 already added — skip if nothing to add)

**Interfaces:**
- Consumes: `apiRequest` from `./api-client` (Task 4); `getStoredTokens`, `storeTokens`, `clearStoredTokens`, `tokensFromLoginResponse`, `StoredTokens` from `./tokenStorage` (Task 2); `refreshTokens` from `./refresh` (Task 3); `decodeAccessTokenPayload` from `./jwt` (Task 2).
- Produces:
  - `AuthProvider({ children }: { children: ReactNode }): JSX.Element`
  - `useAuth(): { isAuthenticated: boolean; role: string | null; login(role: string, password: string, label?: string): Promise<void>; logout(): Promise<void> }`
  - `hasValidTokens(): boolean` — a synchronous, context-free check for use in router loaders (Task 9), which run outside the React tree.

- [ ] **Step 1: Write the failing tests**

`frontend/packages/shared/tests/auth.test.tsx`:

```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, hasValidTokens, useAuth } from "../src/auth";
import { getStoredTokens } from "../src/tokenStorage";

function base64url(input: object): string {
  const json = JSON.stringify(input);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeAccessToken(role: string, exp: number): string {
  return `${base64url({ alg: "HS256" })}.${base64url({ role, iat: 0, exp })}.unsigned`;
}

function Probe() {
  const { isAuthenticated, role, login, logout } = useAuth();
  return (
    <div>
      <p>authenticated: {String(isAuthenticated)}</p>
      <p>role: {role ?? "none"}</p>
      <button onClick={() => login("admin", "secret")}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AuthProvider / useAuth", () => {
  it("starts unauthenticated when nothing is stored", () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    expect(screen.getByText("authenticated: false")).toBeInTheDocument();
    expect(hasValidTokens()).toBe(false);
  });

  it("login stores tokens and exposes the decoded role", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: fakeAccessToken("admin", 9999999999),
          refresh_token: "r",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await act(async () => {
      screen.getByText("login").click();
    });

    await waitFor(() => {
      expect(screen.getByText("authenticated: true")).toBeInTheDocument();
      expect(screen.getByText("role: admin")).toBeInTheDocument();
    });
    expect(hasValidTokens()).toBe(true);
  });

  it("logout clears local state even when the server call fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: fakeAccessToken("admin", 9999999999),
            refresh_token: "r",
            expires_in: 1800,
          }),
          { status: 200 }
        )
      )
      // logout's own POST fails, then its 401-triggered refresh attempt also fails
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 500 }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await act(async () => {
      screen.getByText("login").click();
    });
    await waitFor(() => screen.getByText("authenticated: true"));

    await act(async () => {
      screen.getByText("logout").click();
    });

    await waitFor(() => {
      expect(screen.getByText("authenticated: false")).toBeInTheDocument();
    });
    expect(getStoredTokens()).toBeNull();
  });

  it("schedules a silent refresh 30 seconds before expiry", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    localStorage.setItem(
      "tournament-admin.auth.v1",
      JSON.stringify({
        accessToken: fakeAccessToken("admin", 9999999999),
        refreshToken: "r",
        expiresAt: now + 5000,
      })
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: fakeAccessToken("admin", 9999999999),
          refresh_token: "r2",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    // Refresh fires at expiresAt - 30s, i.e. -25s from now — already due,
    // so it should fire on the next timer tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({ method: "POST" })
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/auth.test.tsx`
Expected: FAIL — `../src/auth` does not exist.

- [ ] **Step 3: Implement the auth context**

`frontend/packages/shared/src/auth.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiRequest } from "./api-client";
import {
  clearStoredTokens,
  getStoredTokens,
  storeTokens,
  tokensFromLoginResponse,
  type StoredTokens,
} from "./tokenStorage";
import { refreshTokens } from "./refresh";
import { decodeAccessTokenPayload } from "./jwt";

/** How long before expiry the silent-refresh timer fires. */
const REFRESH_MARGIN_MS = 30_000;

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface AuthState {
  isAuthenticated: boolean;
  role: string | null;
}

interface AuthContextValue extends AuthState {
  login: (role: string, password: string, label?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function stateFromTokens(tokens: StoredTokens | null): AuthState {
  if (!tokens) return { isAuthenticated: false, role: null };
  try {
    const payload = decodeAccessTokenPayload(tokens.accessToken);
    return { isAuthenticated: true, role: payload.role };
  } catch {
    return { isAuthenticated: false, role: null };
  }
}

/** Synchronous, context-free check for router loaders (outside the React tree). */
export function hasValidTokens(): boolean {
  return getStoredTokens() !== null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => stateFromTokens(getStoredTokens()));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(
    (tokens: StoredTokens) => {
      clearTimer();
      const delay = Math.max(tokens.expiresAt - Date.now() - REFRESH_MARGIN_MS, 0);
      timerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const next = await refreshTokens();
            setState(stateFromTokens(next));
            scheduleRefresh(next);
          } catch {
            setState({ isAuthenticated: false, role: null });
          }
        })();
      }, delay);
    },
    [clearTimer]
  );

  useEffect(() => {
    const tokens = getStoredTokens();
    if (tokens) {
      scheduleRefresh(tokens);
    }
    return clearTimer;
    // Runs once on mount only — scheduleRefresh/clearTimer are stable
    // useCallback references that would otherwise cause a lint warning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (role: string, password: string, label?: string) => {
      const response = await apiRequest<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: { role, password, label },
      });
      const tokens = tokensFromLoginResponse(response);
      storeTokens(tokens);
      setState(stateFromTokens(tokens));
      scheduleRefresh(tokens);
    },
    [scheduleRefresh]
  );

  const logout = useCallback(async () => {
    const tokens = getStoredTokens();
    clearTimer();
    if (tokens) {
      try {
        await apiRequest<void>("/api/auth/logout", {
          method: "POST",
          body: { refresh_token: tokens.refreshToken },
        });
      } catch {
        // Best-effort server-side revocation. The user is logged out
        // locally regardless — see the spec's "Explicit logout" section.
      }
    }
    clearStoredTokens();
    setState({ isAuthenticated: false, role: null });
  }, [clearTimer]);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend/packages/shared && npx vitest run tests/auth.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the barrel**

`frontend/packages/shared/src/index.ts` — add:

```ts
export * from "./auth";
```

- [ ] **Step 6: Run the full shared test suite and commit**

Run: `cd frontend/packages/shared && npm test`
Expected: all tests pass.

```bash
git add frontend/packages/shared
git commit -m "Add shared React auth context: login, logout, silent refresh"
```

---

### Task 6: `shared/i18n`

**Files:**
- Create: `frontend/packages/shared/src/i18n.ts`
- Create: `frontend/packages/shared/tests/i18n.test.ts`
- Modify: `frontend/packages/shared/src/index.ts`

**Interfaces:**
- Produces: `initI18n(resources: Record<string, Record<string, unknown>>, options?: { lng?: string }): typeof i18next` — a thin react-i18next setup function each app calls with its own locale resource bundles (so the future scorer UI supplies its own translations through the same mechanism).

- [ ] **Step 1: Write the failing test**

`frontend/packages/shared/tests/i18n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initI18n } from "../src/i18n";

describe("initI18n", () => {
  it("initializes react-i18next with the given resources and translates by key", async () => {
    const i18n = initI18n({
      en: { translation: { greeting: "Hello" } },
      zh: { translation: { greeting: "你好" } },
    });

    expect(i18n.t("greeting")).toBe("Hello");

    await i18n.changeLanguage("zh");
    expect(i18n.t("greeting")).toBe("你好");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/packages/shared && npx vitest run tests/i18n.test.ts`
Expected: FAIL — `../src/i18n` does not exist.

- [ ] **Step 3: Implement i18n setup**

`frontend/packages/shared/src/i18n.ts`:

```ts
import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

export function initI18n(
  resources: Resource,
  options?: { lng?: string }
): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources,
      lng: options?.lng ?? "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
  }
  return i18next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/packages/shared && npx vitest run tests/i18n.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Export from the barrel**

`frontend/packages/shared/src/index.ts` — add:

```ts
export * from "./i18n";
```

- [ ] **Step 6: Run the full shared test suite and commit**

Run: `cd frontend/packages/shared && npm test`
Expected: all tests pass.

```bash
git add frontend/packages/shared
git commit -m "Add shared react-i18next setup helper"
```

---

### Task 7: `shared/realtime`

**Files:**
- Create: `frontend/packages/shared/src/realtime.ts`
- Create: `frontend/packages/shared/tests/realtime.test.tsx`
- Modify: `frontend/packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `getStoredTokens` from `./tokenStorage` (Task 2).
- Produces:
  - `interface RealtimeEvent { type: string; [key: string]: unknown }`
  - `interface UseRealtimeChannelOptions { path: string; onEvent?: (event: RealtimeEvent) => void; enabled?: boolean }`
  - `useRealtimeChannel(options: UseRealtimeChannelOptions): { connected: boolean }`

- [ ] **Step 1: Write the failing test**

`frontend/packages/shared/tests/realtime.test.tsx`:

```tsx
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeTokens } from "../src/tokenStorage";
import { useRealtimeChannel, type RealtimeEvent } from "../src/realtime";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function Probe({ onEvent }: { onEvent: (event: RealtimeEvent) => void }) {
  const { connected } = useRealtimeChannel({ path: "/ws/active-session", onEvent });
  return <p>connected: {String(connected)}</p>;
}

beforeEach(() => {
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  storeTokens({ accessToken: "token-abc", refreshToken: "r", expiresAt: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useRealtimeChannel", () => {
  it("connects with the stored access token in the URL", () => {
    render(<Probe onEvent={() => {}} />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/ws/active-session?token=token-abc");
  });

  it("calls onEvent with the parsed JSON payload of each message", async () => {
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} />);
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: "active_session_changed" }) });
    });

    expect(onEvent).toHaveBeenCalledWith({ type: "active_session_changed" });
  });

  it("reports connected after onopen and not connected after onclose", async () => {
    const { getByText } = render(<Probe onEvent={() => {}} />);
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.onopen?.();
    });
    await waitFor(() => expect(getByText("connected: true")).toBeInTheDocument());

    act(() => {
      socket.onclose?.();
    });
    await waitFor(() => expect(getByText("connected: false")).toBeInTheDocument());
  });

  it("reconnects after a close, opening a second socket", async () => {
    vi.useFakeTimers();
    render(<Probe onEvent={() => {}} />);
    const firstSocket = FakeWebSocket.instances[0];

    act(() => {
      firstSocket.onclose?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/packages/shared && npx vitest run tests/realtime.test.tsx`
Expected: FAIL — `../src/realtime` does not exist.

- [ ] **Step 3: Implement the realtime hook**

`frontend/packages/shared/src/realtime.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { getStoredTokens } from "./tokenStorage";

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface UseRealtimeChannelOptions {
  /** Path of the WebSocket endpoint, e.g. "/ws/active-session". */
  path: string;
  onEvent?: (event: RealtimeEvent) => void;
  enabled?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function useRealtimeChannel({
  path,
  onEvent,
  enabled = true,
}: UseRealtimeChannelOptions): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return undefined;

    let socket: WebSocket | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      const tokens = getStoredTokens();
      if (!tokens) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}${path}?token=${encodeURIComponent(
        tokens.accessToken
      )}`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        setConnected(true);
      };
      socket.onmessage = (message: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(message.data) as RealtimeEvent;
          onEventRef.current?.(parsed);
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [path, enabled]);

  return { connected };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/packages/shared && npx vitest run tests/realtime.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the barrel**

`frontend/packages/shared/src/index.ts` — add:

```ts
export * from "./realtime";
```

- [ ] **Step 6: Run the full shared test suite and commit**

Run: `cd frontend/packages/shared && npm test`
Expected: all tests pass (this closes out `packages/shared` for this sub-project).

```bash
git add frontend/packages/shared
git commit -m "Add shared real-time WebSocket channel hook with reconnect backoff"
```

---

### Task 8: Backend static file serving

**Files:**
- Modify: `server/src/tournament_server/settings.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_static_ui.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (backend-only; independent of the frontend tasks).
- Produces: `create_app(..., static_dir: str | None = None)` — the app now serves the built admin UI (and falls back to `index.html` for client-side routes) when a static directory is present, and is unaffected when it's absent (existing behavior for every other test in the suite is unchanged).

- [ ] **Step 1: Write the failing tests**

`server/tests/test_static_ui.py`:

```python
from pathlib import Path

from fastapi.testclient import TestClient

from tournament_server.app import create_app


def _make_static_dir(tmp_path: Path) -> Path:
    static_dir = tmp_path / "dist"
    (static_dir / "assets").mkdir(parents=True)
    (static_dir / "index.html").write_text("<html>admin ui</html>")
    (static_dir / "assets" / "app.js").write_text("console.log('app');")
    return static_dir


def test_serves_index_html_at_root(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert "admin ui" in response.text


def test_serves_index_html_for_a_client_side_route(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/events/new")
    assert response.status_code == 200
    assert "admin ui" in response.text


def test_serves_static_assets(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/assets/app.js")
    assert response.status_code == 200
    assert "console.log" in response.text


def test_unknown_api_path_still_404s_instead_of_serving_index_html(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/api/this-route-does-not-exist")
    assert response.status_code == 404
    assert "admin ui" not in response.text


def test_missing_static_dir_leaves_the_app_working(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(tmp_path / "does-not-exist"),
    )
    with TestClient(app) as client:
        health = client.get("/health")
        root = client.get("/")
    assert health.status_code == 200
    assert root.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_static_ui.py -v`
Expected: FAIL — `create_app() got an unexpected keyword argument 'static_dir'`.

- [ ] **Step 3: Add the `static_dir` setting**

In `server/src/tournament_server/settings.py`, add the field to the `Settings` dataclass and its `from_env` construction (matching the existing fields' pattern at `server/src/tournament_server/settings.py:8-25`):

```python
    static_dir: str | None = None
```

Add to the `from_env` classmethod's returned `cls(...)` call:

```python
            static_dir=os.environ.get("TOURNAMENT_STATIC_DIR"),
```

- [ ] **Step 4: Wire static serving into `create_app`**

In `server/src/tournament_server/app.py`, add these imports at the top alongside the existing `fastapi` import:

```python
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
```

(This replaces the existing `from fastapi import FastAPI, Request` line — add `HTTPException` to it.)

Add, near the top of the module (module-level, alongside other constants):

```python
# .../server/src/tournament_server/app.py -> tournament_server -> src -> server -> repo root
_DEFAULT_STATIC_DIR = (
    Path(__file__).resolve().parents[3] / "frontend" / "apps" / "admin" / "dist"
)
```

Add the `static_dir` parameter to `create_app`'s signature, alongside `port`:

```python
def create_app(
    db_path: str | None = None,
    plugins_root: str | None = None,
    port: int | None = None,
    static_dir: str | None = None,
) -> FastAPI:
```

Inside `create_app`, alongside the existing `if port is not None:` override block:

```python
    if static_dir is not None:
        settings.static_dir = static_dir
```

At the very end of `create_app`, immediately before the existing `@app.get("/health")` block, add:

```python
    resolved_static_dir = (
        Path(settings.static_dir) if settings.static_dir else _DEFAULT_STATIC_DIR
    )
    if resolved_static_dir.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=resolved_static_dir / "assets"),
            name="admin-ui-assets",
        )

        @app.get("/{full_path:path}")
        def serve_admin_ui(full_path: str) -> FileResponse:
            if full_path.startswith(("api/", "ws/")) or full_path == "health":
                raise HTTPException(status_code=404, detail="Not Found")
            return FileResponse(resolved_static_dir / "index.html")
```

(This must come before `@app.get("/health")` is defined for readability, but FastAPI matches the exact `/health` route ahead of the catch-all regardless of definition order relative to it, since the catch-all's own guard also explicitly 404s on `full_path == "health"` as defense in depth — leaving `/health` correctly reachable either way.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_static_ui.py -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full backend test suite**

Run: `cd server && .venv/bin/python -m pytest`
Expected: all tests pass (this change is additive and gated on `static_dir`/`resolved_static_dir.is_dir()`, so no existing test is affected).

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/settings.py server/src/tournament_server/app.py server/tests/test_static_ui.py
git commit -m "Serve the built admin UI as static assets with SPA fallback"
```

---

### Task 9: Bootstrap flow — event creation, login, authenticated shell skeleton

**Files:**
- Create: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/errorBanner.ts`
- Create: `frontend/apps/admin/src/queryClient.ts`
- Create: `frontend/apps/admin/src/router.tsx`
- Create: `frontend/apps/admin/src/routes/EventsNewRoute.tsx`
- Create: `frontend/apps/admin/src/routes/LoginRoute.tsx`
- Create: `frontend/apps/admin/src/routes/AuthenticatedLayout.tsx`
- Create: `frontend/apps/admin/src/routes/DashboardRoute.tsx`
- Create: `frontend/apps/admin/src/components/AppShell.tsx`
- Create: `frontend/apps/admin/src/components/TransientErrorBanner.tsx`
- Create: `frontend/apps/admin/src/i18n/en/admin.json`
- Create: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/src/i18nSetup.ts`
- Modify: `frontend/apps/admin/src/main.tsx`
- Modify: `frontend/apps/admin/src/App.tsx` (deleted — replaced by the router; see Step 9)
- Create: `frontend/apps/admin/tests/e2e/bootstrap.spec.ts`
- Delete: `frontend/apps/admin/tests/unit/App.test.tsx` (the placeholder `App` component this task removes)

**Interfaces:**
- Consumes: `AuthProvider`, `useAuth`, `hasValidTokens`, `ApiError`, `apiRequest`, `initI18n` from `@tournament-admin/shared` (Tasks 2-6).
- Produces:
  - `frontend/apps/admin/src/types.ts` exporting `interface EventRead { id: number; name: string; active_session_id: number | null; game_plugin_name: string | null; created_at: string }` — the one definition every later task imports instead of redeclaring it (Task 10 adds `PluginSummary` and `ServerInfo` to this same file).
  - `showTransientError(message: string): void` from `errorBanner.ts`, called by `queryClient.ts`'s `QueryCache.onError` — any later task whose `useQuery` calls fail (not just mutations, which already show their own inline errors) gets this banner for free with no per-page wiring.
  - The route tree other tasks nest additional routes into (`events/setup`, `settings/roles` are added by Tasks 10-11 as siblings of `DashboardRoute` under the `/` route), and `frontend/apps/admin/src/i18n/en/admin.json` / `zh/admin.json`, which every later page task appends its own keys to.

This is the first vertical slice and is sized as one task because its three pieces are mutually dependent for testing: you cannot exercise the "no event yet" redirect without a login screen to land on eventually, and you cannot test login without an event-creation screen to get there from first.

- [ ] **Step 1: Add the shared page-level types and the transient error banner store**

`frontend/apps/admin/src/types.ts`:

```ts
export interface EventRead {
  id: number;
  name: string;
  active_session_id: number | null;
  game_plugin_name: string | null;
  created_at: string;
}
```

`frontend/apps/admin/src/errorBanner.ts`:

```ts
type Listener = (message: string | null) => void;

let currentMessage: string | null = null;
const listeners = new Set<Listener>();

/**
 * A tiny external store (not React state) so queryClient.ts — created
 * outside the component tree — can push a message that
 * TransientErrorBanner (inside AppShell) subscribes to and renders.
 * Mutations already show their own inline errors next to the form that
 * caused them; this banner is for background query failures instead
 * (e.g. a dropped connection while a page's data silently refetches).
 */
export function showTransientError(message: string): void {
  currentMessage = message;
  listeners.forEach((listener) => listener(currentMessage));
}

export function dismissTransientError(): void {
  currentMessage = null;
  listeners.forEach((listener) => listener(null));
}

export function subscribeTransientError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTransientError(): string | null {
  return currentMessage;
}
```

- [ ] **Step 2: Set up TanStack Query's client, wired to the error banner**

`frontend/apps/admin/src/queryClient.ts`:

```ts
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@tournament-admin/shared";
import { showTransientError } from "./errorBanner";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      showTransientError(error instanceof ApiError ? error.detail : "Network error.");
    },
  }),
});
```

- [ ] **Step 3: Add locale files**

`frontend/apps/admin/src/i18n/en/admin.json`:

```json
{
  "app": {
    "title": "Tournament Admin"
  },
  "login": {
    "heading": "Log in",
    "roleLabel": "Role",
    "passwordLabel": "Password",
    "submit": "Log in",
    "invalidCredentials": "Invalid role or password."
  },
  "eventsNew": {
    "heading": "Set up your event",
    "nameLabel": "Event name",
    "passwordLabel": "Initial password (used for all roles until changed)",
    "submit": "Create event"
  },
  "shell": {
    "logout": "Log out",
    "dashboardLink": "Dashboard",
    "eventSetupLink": "Event & plugins",
    "rolesLink": "Role passwords",
    "dismiss": "Dismiss"
  },
  "dashboard": {
    "heading": "Dashboard",
    "eventNameLabel": "Event"
  }
}
```

`frontend/apps/admin/src/i18n/zh/admin.json`:

```json
{
  "app": {
    "title": "赛事管理"
  },
  "login": {
    "heading": "登录",
    "roleLabel": "角色",
    "passwordLabel": "密码",
    "submit": "登录",
    "invalidCredentials": "角色或密码无效。"
  },
  "eventsNew": {
    "heading": "设置您的赛事",
    "nameLabel": "赛事名称",
    "passwordLabel": "初始密码(适用于所有角色,直至更改)",
    "submit": "创建赛事"
  },
  "shell": {
    "logout": "登出",
    "dashboardLink": "仪表盘",
    "eventSetupLink": "赛事与插件",
    "rolesLink": "角色密码",
    "dismiss": "关闭"
  },
  "dashboard": {
    "heading": "仪表盘",
    "eventNameLabel": "赛事"
  }
}
```

`frontend/apps/admin/src/i18nSetup.ts`:

```ts
import { initI18n } from "@tournament-admin/shared";
import en from "./i18n/en/admin.json";
import zh from "./i18n/zh/admin.json";

initI18n({
  en: { translation: en },
  zh: { translation: zh },
});
```

- [ ] **Step 4: Write the login route**

`frontend/apps/admin/src/routes/LoginRoute.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ApiError, useAuth } from "@tournament-admin/shared";

export function LoginRoute() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await login(role, password);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(t("login.invalidCredentials"));
      } else {
        throw err;
      }
    }
  }

  return (
    <main>
      <h1>{t("login.heading")}</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="role">{t("login.roleLabel")}</label>
          <input
            id="role"
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password">{t("login.passwordLabel")}</label>
          <input
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={error ? "login-error" : undefined}
          />
        </div>
        {error && (
          <p id="login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit">{t("login.submit")}</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Write the event-creation route**

`frontend/apps/admin/src/routes/EventsNewRoute.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export function EventsNewRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<EventRead>("/api/event", {
        method: "POST",
        body: { name, password },
      }),
    onSuccess: () => navigate("/login", { replace: true }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <main>
      <h1>{t("eventsNew.heading")}</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="event-name">{t("eventsNew.nameLabel")}</label>
          <input
            id="event-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="event-password">{t("eventsNew.passwordLabel")}</label>
          <input
            id="event-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={mutation.isError ? "event-create-error" : undefined}
          />
        </div>
        {mutation.isError && (
          <p id="event-create-error" role="alert">
            {mutation.error instanceof ApiError
              ? mutation.error.detail
              : "Something went wrong."}
          </p>
        )}
        <button type="submit" disabled={mutation.isPending}>
          {t("eventsNew.submit")}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Write the transient error banner, app shell, and authenticated layout**

`frontend/apps/admin/src/components/TransientErrorBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  dismissTransientError,
  getTransientError,
  subscribeTransientError,
} from "../errorBanner";

export function TransientErrorBanner() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<string | null>(getTransientError());

  useEffect(() => subscribeTransientError(setMessage), []);

  if (!message) return null;

  return (
    <div role="alert">
      <p>{message}</p>
      <button onClick={dismissTransientError}>{t("shell.dismiss")}</button>
    </div>
  );
}
```

`frontend/apps/admin/src/components/AppShell.tsx`:

```tsx
import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@tournament-admin/shared";
import { TransientErrorBanner } from "./TransientErrorBanner";

export function AppShell() {
  const { t } = useTranslation();
  const { role, logout } = useAuth();

  return (
    <div>
      <header>
        <p>{t("app.title")}</p>
        <button onClick={() => void logout()}>{t("shell.logout")}</button>
      </header>
      <TransientErrorBanner />
      {role === "admin" && (
        <nav>
          <NavLink to="/">{t("shell.dashboardLink")}</NavLink>
          <NavLink to="/events/setup">{t("shell.eventSetupLink")}</NavLink>
          <NavLink to="/settings/roles">{t("shell.rolesLink")}</NavLink>
        </nav>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
```

`frontend/apps/admin/src/routes/AuthenticatedLayout.tsx`:

```tsx
import { Navigate } from "react-router-dom";
import { hasValidTokens } from "@tournament-admin/shared";
import { AppShell } from "../components/AppShell";

export function AuthenticatedLayout() {
  if (!hasValidTokens()) {
    return <Navigate to="/login" replace />;
  }
  return <AppShell />;
}
```

(`AppShell` renders the nav/header chrome and its own `<Outlet />` for the nested route — e.g. `DashboardRoute` below — to render into.)

- [ ] **Step 7: Write the dashboard route**

`frontend/apps/admin/src/routes/DashboardRoute.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export function DashboardRoute() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });

  return (
    <div>
      <h1>{t("dashboard.heading")}</h1>
      {data && (
        <p>
          {t("dashboard.eventNameLabel")}: {data.name}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Wire the router with the event-exists-first bootstrap check**

`frontend/apps/admin/src/router.tsx`:

```tsx
import { createBrowserRouter, redirect } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "./types";
import { EventsNewRoute } from "./routes/EventsNewRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { AuthenticatedLayout } from "./routes/AuthenticatedLayout";
import { DashboardRoute } from "./routes/DashboardRoute";

async function eventExists(): Promise<boolean> {
  try {
    await apiRequest<EventRead>("/api/event");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * GET /api/event is unauthenticated on the backend (no role credentials
 * exist until an event is created), so this check MUST happen before any
 * token check — see the spec's "Routing & guards" section. A fresh
 * install redirects to /events/new before any login is even possible.
 */
async function rootLoader() {
  if (!(await eventExists())) {
    return redirect("/events/new");
  }
  return null;
}

async function eventsNewLoader() {
  if (await eventExists()) {
    return redirect("/login");
  }
  return null;
}

export const router = createBrowserRouter([
  {
    path: "/events/new",
    loader: eventsNewLoader,
    element: <EventsNewRoute />,
  },
  {
    path: "/login",
    element: <LoginRoute />,
  },
  {
    path: "/",
    loader: rootLoader,
    element: <AuthenticatedLayout />,
    children: [{ index: true, element: <DashboardRoute /> }],
  },
]);
```

(Tasks 10 and 11 each add one more entry to the `children` array above, and one more import — see their own "Register the route" steps.)

- [ ] **Step 9: Wire everything into `main.tsx`, and remove the placeholder `App`**

Delete `frontend/apps/admin/src/App.tsx` and `frontend/apps/admin/tests/unit/App.test.tsx` — they were a scaffolding placeholder for Task 1's toolchain smoke test, superseded by the real router now in place.

`frontend/apps/admin/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@tournament-admin/shared";
import "./i18nSetup";
import { router } from "./router";
import { queryClient } from "./queryClient";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 10: Update the Task 1 E2E smoke test's expectation**

`frontend/apps/admin/tests/e2e/smoke.spec.ts` — replace its contents, since the placeholder `App` component (and its "Tournament Admin" text at `/`) no longer exists; the smoke test now belongs to this task's own bootstrap spec instead. Delete `frontend/apps/admin/tests/e2e/smoke.spec.ts`.

- [ ] **Step 11: Write the bootstrap E2E tests**

`frontend/apps/admin/tests/e2e/bootstrap.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe.serial("bootstrap: event creation, login, and the authenticated shell", () => {
  test("a fresh install redirects to /events/new", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/events\/new$/);
    await expect(page.getByRole("heading", { name: "Set up your event" })).toBeVisible();
  });

  test("creating the event redirects to /login", async ({ page }) => {
    await page.goto("/events/new");
    await page.getByLabel("Event name").fill("Regional Qualifier");
    await page.getByLabel(/Initial password/).fill("bootstrap-pw");
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("bad credentials show an inline error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid role or password.");
  });

  test("logging in as admin lands on the dashboard showing the event name", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText("Event: Regional Qualifier")).toBeVisible();
  });

  test("a session close to expiry is silently refreshed without forcing a re-login", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const originalRefreshToken = await page.evaluate(() => {
      const stored = JSON.parse(
        localStorage.getItem("tournament-admin.auth.v1") ?? "null"
      );
      const nearExpiry = { ...stored, expiresAt: Date.now() + 2_000 };
      localStorage.setItem("tournament-admin.auth.v1", JSON.stringify(nearExpiry));
      return stored.refreshToken as string;
    });

    await page.reload();
    await expect(page.getByText("Event: Regional Qualifier")).toBeVisible();

    // The silent-refresh timer (30s before expiresAt, so immediately for
    // a 2s-out expiry) should have rotated the refresh token by now,
    // without the user ever seeing a login screen.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const stored = JSON.parse(
            localStorage.getItem("tournament-admin.auth.v1") ?? "null"
          );
          return stored?.refreshToken as string | undefined;
        })
      )
      .not.toBe(originalRefreshToken);
    await expect(page).toHaveURL("/");
  });

  test("explicit logout revokes the refresh token server-side and redirects to /login", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    const refreshToken = await page.evaluate(() => {
      const stored = JSON.parse(
        localStorage.getItem("tournament-admin.auth.v1") ?? "null"
      );
      return stored.refreshToken as string;
    });

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    const reuseResponse = await page.request.post("/api/auth/refresh", {
      data: { refresh_token: refreshToken },
    });
    expect(reuseResponse.status()).toBe(401);
  });
});
```

- [ ] **Step 12: Run the E2E tests**

Run: `cd frontend/apps/admin && npm run test:e2e`
Expected: all 6 tests pass, run serially (`test.describe.serial`) since each depends on state the previous test left behind (the single event this backend instance allows).

- [ ] **Step 13: Run the unit test suite and the build**

Run: `cd frontend/apps/admin && npm test`
Expected: passes (the deleted `App.test.tsx` is gone; no unit tests remain from this task, which is fully covered end-to-end above — this is expected and acceptable given the router/auth wiring is what's under test, not isolable component logic).

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

- [ ] **Step 14: Commit**

```bash
git add frontend/apps/admin
git commit -m "Add bootstrap flow: event creation, login, authenticated shell skeleton"
```

---

### Task 10: Event setup — plugin install/selection + server-info QR display

**Files:**
- Modify: `frontend/apps/admin/src/types.ts` (add `PluginSummary` and `ServerInfo`)
- Create: `frontend/apps/admin/src/routes/EventSetupRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx` (add the `/events/setup` child route)
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts`
- Create: `frontend/apps/admin/tests/e2e/eventSetup.spec.ts`

**Interfaces:**
- Consumes: `apiRequest`, `ApiError` from `@tournament-admin/shared`; `EventRead` from `../types` (Task 9); the `AuthenticatedLayout`/`AppShell` route tree from Task 9.
- Produces: `PluginSummary { name: string; version: string; display_name: string }` and `ServerInfo { port: number; addresses: string[] }`, appended to `frontend/apps/admin/src/types.ts`. Nothing later tasks depend on directly beyond that (Task 11 and 12 are independent siblings), beyond the router now having `/events/setup` registered.

- [ ] **Step 1: Extend the shared types and add locale keys**

`frontend/apps/admin/src/types.ts` — add, alongside the existing `EventRead`:

```ts
export interface PluginSummary {
  name: string;
  version: string;
  display_name: string;
}

export interface ServerInfo {
  port: number;
  addresses: string[];
}
```

`frontend/apps/admin/src/i18n/en/admin.json` — merge in:

```json
{
  "eventSetup": {
    "heading": "Event & plugins",
    "gamePluginsHeading": "Game plugins",
    "schedulerPluginsHeading": "Scheduler plugins",
    "installLabel": "Install a plugin (.zip)",
    "installGameSubmit": "Install game plugin",
    "installSchedulerSubmit": "Install scheduler plugin",
    "selectSubmit": "Select for this event",
    "selectedLabel": "Selected",
    "serverInfoHeading": "Connect a device on this network",
    "serverInfoAddressLabel": "Address"
  }
}
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge in:

```json
{
  "eventSetup": {
    "heading": "赛事与插件",
    "gamePluginsHeading": "比赛插件",
    "schedulerPluginsHeading": "排程插件",
    "installLabel": "安装插件 (.zip)",
    "installGameSubmit": "安装比赛插件",
    "installSchedulerSubmit": "安装排程插件",
    "selectSubmit": "为本赛事选择",
    "selectedLabel": "已选择",
    "serverInfoHeading": "在此网络上连接设备",
    "serverInfoAddressLabel": "地址"
  }
}
```

- [ ] **Step 2: Write the event setup route**

`frontend/apps/admin/src/routes/EventSetupRoute.tsx`:

```tsx
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead, PluginSummary, ServerInfo } from "../types";

function PluginList({
  kind,
  headingKey,
  installLabelKey,
  installSubmitKey,
}: {
  kind: "games" | "schedulers";
  headingKey: string;
  installLabelKey: string;
  installSubmitKey: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["plugins", kind];

  const { data: plugins } = useQuery({
    queryKey,
    queryFn: () => apiRequest<PluginSummary[]>(`/api/plugins/${kind}`),
  });

  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });

  const installMutation = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiRequest<PluginSummary>(`/api/plugins/${kind}`, {
        method: "POST",
        body: form,
        isFormData: true,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const selectMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<EventRead>("/api/event/game-plugin", {
        method: "POST",
        body: { name },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["event"] }),
  });

  function handleFileChange(changeEvent: ChangeEvent<HTMLInputElement>) {
    const file = changeEvent.target.files?.[0];
    if (file) installMutation.mutate(file);
  }

  return (
    <section>
      <h2>{t(headingKey)}</h2>
      <ul>
        {plugins?.map((plugin) => (
          <li key={plugin.name}>
            {plugin.display_name} ({plugin.version})
            {kind === "games" &&
              (event?.game_plugin_name === plugin.name ? (
                <span> — {t("eventSetup.selectedLabel")}</span>
              ) : (
                <button
                  onClick={() => selectMutation.mutate(plugin.name)}
                  disabled={Boolean(event?.game_plugin_name) || selectMutation.isPending}
                >
                  {t("eventSetup.selectSubmit")}
                </button>
              ))}
          </li>
        ))}
      </ul>
      <label htmlFor={`install-${kind}`}>{t(installLabelKey)}</label>
      <input
        id={`install-${kind}`}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
      />
      {installMutation.isError && (
        <p role="alert">
          {installMutation.error instanceof ApiError
            ? installMutation.error.detail
            : "Install failed."}
        </p>
      )}
      <span aria-hidden="true">{t(installSubmitKey)}</span>
    </section>
  );
}

function ServerInfoPanel() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["server-info"],
    queryFn: () => apiRequest<ServerInfo>("/api/server-info"),
  });
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});

  useEffect(() => {
    if (!data) return;
    for (const address of data.addresses) {
      const canvas = canvasRefs.current[address];
      if (canvas) {
        void QRCode.toCanvas(canvas, `http://${address}:${data.port}`);
      }
    }
  }, [data]);

  if (!data) return null;

  return (
    <section>
      <h2>{t("eventSetup.serverInfoHeading")}</h2>
      {data.addresses.map((address) => (
        <div key={address}>
          <p>
            {t("eventSetup.serverInfoAddressLabel")}: {address}:{data.port}
          </p>
          <canvas ref={(node) => (canvasRefs.current[address] = node)} />
        </div>
      ))}
    </section>
  );
}

export function EventSetupRoute() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t("eventSetup.heading")}</h1>
      <PluginList
        kind="games"
        headingKey="eventSetup.gamePluginsHeading"
        installLabelKey="eventSetup.installLabel"
        installSubmitKey="eventSetup.installGameSubmit"
      />
      <PluginList
        kind="schedulers"
        headingKey="eventSetup.schedulerPluginsHeading"
        installLabelKey="eventSetup.installLabel"
        installSubmitKey="eventSetup.installSchedulerSubmit"
      />
      <ServerInfoPanel />
    </div>
  );
}
```

- [ ] **Step 3: Register the route**

In `frontend/apps/admin/src/router.tsx`, add the import:

```ts
import { EventSetupRoute } from "./routes/EventSetupRoute";
```

And add a sibling entry to the `AuthenticatedLayout` children array (alongside the existing `{ index: true, element: <DashboardRoute /> }`):

```ts
      { path: "events/setup", element: <EventSetupRoute /> },
```

- [ ] **Step 4: Write the plugin-zip test fixture builder**

`frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts`:

```ts
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";

const EXAMPLE_GAME_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../../../../server/tests/fixtures/plugins/games/example-game"
);

export async function buildExampleGamePluginZip(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `example-game-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(EXAMPLE_GAME_PLUGIN_DIR, false);
    void archive.finalize();
  });
  return outPath;
}
```

- [ ] **Step 5: Write the E2E test**

`frontend/apps/admin/tests/e2e/eventSetup.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

test.describe.serial("event setup: plugin install and selection", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: "Setup Test Event", password: "setup-pw" },
    });
    // Ignore 409 (already created by a prior spec file's run against the
    // same backend instance) — this suite only needs an event to exist.
    expect([201, 409]).toContain(createResponse.status());
  });

  test("installing and selecting a game plugin reflects on the dashboard", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("setup-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Event & plugins" }).click();
    await expect(page).toHaveURL(/\/events\/setup$/);

    const zipPath = await buildExampleGamePluginZip();
    await page.getByLabel("Install a plugin (.zip)").first().setInputFiles(zipPath);
    await expect(page.getByText(/example-game/i)).toBeVisible();

    await page.getByRole("button", { name: "Select for this event" }).click();
    await expect(page.getByText("Selected")).toBeVisible();
  });
});
```

- [ ] **Step 6: Run the E2E test**

Run: `cd frontend/apps/admin && npm run test:e2e -- eventSetup.spec.ts`
Expected: passes.

Run the full E2E suite to confirm no regressions from the new route: `cd frontend/apps/admin && npm run test:e2e`
Expected: all tests across all spec files pass.

- [ ] **Step 7: Run the build**

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/admin
git commit -m "Add event setup: plugin install, game-plugin selection, server-info QR"
```

---

### Task 11: Settings — role password management

**Files:**
- Create: `frontend/apps/admin/src/routes/SettingsRolesRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx` (add the `/settings/roles` child route)
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/e2e/settingsRoles.spec.ts`

**Interfaces:**
- Consumes: `apiRequest`, `ApiError` from `@tournament-admin/shared`; the route tree from Task 9.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge in:

```json
{
  "settingsRoles": {
    "heading": "Role passwords",
    "roleLabel": "Role",
    "newPasswordLabel": "New password",
    "submit": "Update password",
    "success": "Password updated."
  }
}
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge in:

```json
{
  "settingsRoles": {
    "heading": "角色密码",
    "roleLabel": "角色",
    "newPasswordLabel": "新密码",
    "submit": "更新密码",
    "success": "密码已更新。"
  }
}
```

- [ ] **Step 2: Write the route**

`frontend/apps/admin/src/routes/SettingsRolesRoute.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";

const ROLES = ["admin", "scorer", "judge", "referee", "attendee", "display_device"];

export function SettingsRolesRoute() {
  const { t } = useTranslation();
  const [role, setRole] = useState(ROLES[0]);
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/api/auth/passwords/${role}`, {
        method: "PATCH",
        body: { password },
      }),
    onSuccess: () => setPassword(""),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <main>
      <h1>{t("settingsRoles.heading")}</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="settings-role">{t("settingsRoles.roleLabel")}</label>
          <select
            id="settings-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {ROLES.map((roleOption) => (
              <option key={roleOption} value={roleOption}>
                {roleOption}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="settings-new-password">
            {t("settingsRoles.newPasswordLabel")}
          </label>
          <input
            id="settings-new-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={mutation.isError ? "settings-roles-error" : undefined}
          />
        </div>
        {mutation.isError && (
          <p id="settings-roles-error" role="alert">
            {mutation.error instanceof ApiError
              ? mutation.error.detail
              : "Something went wrong."}
          </p>
        )}
        {mutation.isSuccess && <p role="status">{t("settingsRoles.success")}</p>}
        <button type="submit" disabled={mutation.isPending}>
          {t("settingsRoles.submit")}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Register the route**

In `frontend/apps/admin/src/router.tsx`, add the import:

```ts
import { SettingsRolesRoute } from "./routes/SettingsRolesRoute";
```

And add a sibling entry to the `AuthenticatedLayout` children array:

```ts
      { path: "settings/roles", element: <SettingsRolesRoute /> },
```

- [ ] **Step 4: Write the E2E test**

`frontend/apps/admin/tests/e2e/settingsRoles.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe.serial("role password management", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: "Roles Test Event", password: "initial-pw" },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("changing scorer's password takes effect: old rejected, new accepted", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("initial-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Role passwords" }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);

    await page.getByLabel("Role").selectOption("scorer");
    await page.getByLabel("New password").fill("scorer-new-pw");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("status")).toHaveText("Password updated.");

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Role").fill("scorer");
    await page.getByLabel("Password").fill("initial-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid role or password.");

    await page.getByLabel("Password").fill("scorer-new-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");
  });
});
```

- [ ] **Step 5: Run the E2E test**

Run: `cd frontend/apps/admin && npm run test:e2e -- settingsRoles.spec.ts`
Expected: passes.

Run the full E2E suite: `cd frontend/apps/admin && npm run test:e2e`
Expected: all tests across all spec files pass.

- [ ] **Step 6: Run the build and commit**

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

```bash
git add frontend/apps/admin
git commit -m "Add role password management settings page"
```

---

### Task 12: Debug event panel

**Files:**
- Create: `frontend/apps/admin/src/components/DebugEventPanel.tsx`
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/unit/DebugEventPanel.test.tsx`
- Create: `frontend/apps/admin/tests/e2e/debugEventPanel.spec.ts`

**Interfaces:**
- Consumes: `useRealtimeChannel`, `RealtimeEvent` from `@tournament-admin/shared` (Task 7); renders inside `AppShell` (Task 9).
- Produces: nothing later tasks depend on — this is the final task of the sub-project.

- [ ] **Step 1: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge in:

```json
{
  "debugPanel": {
    "toggle": "Debug events",
    "empty": "No events received yet."
  }
}
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge in:

```json
{
  "debugPanel": {
    "toggle": "调试事件",
    "empty": "尚未收到任何事件。"
  }
}
```

- [ ] **Step 2: Write the failing unit test**

`frontend/apps/admin/tests/unit/DebugEventPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { initI18n } from "@tournament-admin/shared";
import { DebugEventPanel } from "../../src/components/DebugEventPanel";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    useRealtimeChannel: vi.fn(),
  };
});

import { useRealtimeChannel } from "@tournament-admin/shared";

function renderWithI18n(ui: React.ReactElement) {
  const i18n = initI18n({ en: { translation: { debugPanel: { toggle: "Debug events", empty: "No events received yet." } } } });
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe("DebugEventPanel", () => {
  it("shows a placeholder message when collapsed and opened with no events yet", () => {
    vi.mocked(useRealtimeChannel).mockImplementation(() => ({ connected: true }));

    renderWithI18n(<DebugEventPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Debug events/ }));

    expect(screen.getByText("No events received yet.")).toBeInTheDocument();
  });

  it("lists a received event's type and payload once opened", () => {
    let capturedOnEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      capturedOnEvent = options.onEvent;
      return { connected: true };
    });

    renderWithI18n(<DebugEventPanel />);
    capturedOnEvent?.({ type: "active_session_changed", active_session_id: 7 });
    fireEvent.click(screen.getByRole("button", { name: /Debug events/ }));

    expect(screen.getByText(/active_session_changed/)).toBeInTheDocument();
    expect(screen.getByText(/"active_session_id": 7/)).toBeInTheDocument();
  });

  it("keeps only the last 50 events", () => {
    let capturedOnEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      capturedOnEvent = options.onEvent;
      return { connected: true };
    });

    renderWithI18n(<DebugEventPanel />);
    for (let i = 0; i < 60; i += 1) {
      capturedOnEvent?.({ type: `event-${i}` });
    }
    fireEvent.click(screen.getByRole("button", { name: /Debug events/ }));

    expect(screen.queryByText(/event-0\b/)).not.toBeInTheDocument();
    expect(screen.getByText(/event-59/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/DebugEventPanel.test.tsx`
Expected: FAIL — `../../src/components/DebugEventPanel` does not exist.

- [ ] **Step 4: Implement the panel**

`frontend/apps/admin/src/components/DebugEventPanel.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";

const MAX_EVENTS = 50;

interface LoggedEvent {
  receivedAt: string;
  event: RealtimeEvent;
}

export function DebugEventPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<LoggedEvent[]>([]);

  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      setEvents((prev) =>
        [...prev, { receivedAt: new Date().toISOString(), event }].slice(-MAX_EVENTS)
      );
    },
  });

  return (
    <section>
      <button onClick={() => setOpen((prev) => !prev)}>
        {t("debugPanel.toggle")} ({events.length})
      </button>
      {open && (
        <div>
          {events.length === 0 ? (
            <p>{t("debugPanel.empty")}</p>
          ) : (
            <ul>
              {events.map((entry, index) => (
                <li key={index}>
                  <span>{entry.receivedAt}</span>{" "}
                  <span>{entry.event.type}</span>
                  <pre>{JSON.stringify(entry.event, null, 2)}</pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/DebugEventPanel.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the panel into `AppShell`**

In `frontend/apps/admin/src/components/AppShell.tsx`, add the import:

```ts
import { DebugEventPanel } from "./DebugEventPanel";
```

And render it only for the `admin` role, alongside the existing `{role === "admin" && (<nav>...)}` block:

```tsx
      {role === "admin" && <DebugEventPanel />}
```

- [ ] **Step 7: Write the E2E test**

`frontend/apps/admin/tests/e2e/debugEventPanel.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe.serial("debug event panel", () => {
  let accessToken = "";

  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: "Debug Panel Test Event", password: "debug-pw" },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: "debug-pw" },
    });
    expect(loginResponse.status()).toBe(200);
    const body = await loginResponse.json();
    accessToken = body.access_token as string;

    const sessionResponse = await request.post("/api/sessions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { label: "Day 1" },
    });
    expect(sessionResponse.status()).toBe(201);
  });

  test("an active_session_changed event triggered out-of-band appears once the panel is open", async ({
    page,
    request,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("debug-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("button", { name: /Debug events/ }).click();

    const sessionsResponse = await request.get("/api/sessions", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sessions = await sessionsResponse.json();
    const sessionId = sessions[0].id as number;

    await request.post("/api/event/active-session", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { session_id: sessionId },
    });

    await expect(page.getByText("active_session_changed")).toBeVisible();
  });
});
```

- [ ] **Step 8: Run the E2E test**

Run: `cd frontend/apps/admin && npm run test:e2e -- debugEventPanel.spec.ts`
Expected: passes.

Run the full E2E suite one final time: `cd frontend/apps/admin && npm run test:e2e`
Expected: all tests across all spec files pass.

- [ ] **Step 9: Run the full unit suite and the build**

Run: `cd frontend/apps/admin && npm test`
Expected: all tests pass.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

- [ ] **Step 10: Commit**

```bash
git add frontend/apps/admin
git commit -m "Add debug event panel for the real-time WebSocket channel"
```

---

## Post-implementation checklist (whole-branch review scope)

- All 12 tasks committed, each with its own passing unit and/or E2E tests.
- `cd frontend/packages/shared && npm test` — all pass.
- `cd frontend/apps/admin && npm test` — all pass.
- `cd frontend/apps/admin && npm run test:e2e` — all pass.
- `cd frontend/apps/admin && npm run build` — succeeds.
- `cd server && .venv/bin/python -m pytest` — all pass (unaffected by the additive static-serving change except for the new `test_static_ui.py`).
- WCAG spot check: every form field has a `<label>`; errors use `role="alert"`/`role="status"` and `aria-describedby`; `AppShell` uses `<header>`/`<nav>`/`<main>` landmarks.
- i18n check: every string introduced in this sub-project has both an `en` and a `zh` entry — grep `frontend/apps/admin/src` for hard-coded user-facing string literals outside `i18n/*/admin.json`.
