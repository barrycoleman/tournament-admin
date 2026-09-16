# Frontend instructions for Claude Code

## What this is

The tournament-admin project's frontends live here as an npm workspace:
`frontend/apps/<app>/` (one per UI surface — currently only `admin`) and
`frontend/packages/shared/` (auth/token handling, the API client,
real-time WebSocket hook, and i18n setup — written once, shared by every
app). Each app builds to static assets the Python server
(`server/`) serves directly — see `server/CLAUDE.md`'s "Serving the admin
UI" section for how that wiring works.

Read `docs/superpowers/specs/2026-09-14-admin-ui-shell-design.md` and
`docs/superpowers/plans/2026-09-14-admin-ui-shell.md` before touching the
admin app's auth/token flow, its bootstrap routing, or `packages/shared`
— they document the reasoning behind several non-obvious decisions (see
below). Later UI specs (scorer/tablet, display) live in the same
`docs/superpowers/specs/` directory as they're written.

## Stack

TypeScript, React 19, Vite 5, React Router 6 (data routers), TanStack
Query 5, react-i18next (English + Chinese from day one — every
user-facing string goes through `useTranslation()`/`t(...)`, never a bare
string literal). Vitest + React Testing Library for unit/component
tests. Playwright for E2E tests.

The teams roster screen uses `react-data-grid` and `papaparse`, and both
have sharp edges worth knowing before touching that screen. A
`react-data-grid` column only becomes editable when it has an explicit
`renderEditCell` — `editable: true` on its own is inert in the version
this project uses, despite what the prop's name suggests (text columns
pass the library's own `renderTextEditor`). `papaparse` does double duty:
it parses uploaded CSV files *and* the tab-delimited text a
spreadsheet paste puts on the clipboard, so there is one parser, not two.
And `react-data-grid` isn't testable under jsdom as-shipped:
`apps/admin/vitest.setup.ts` installs a `ResizeObserver` (jsdom has none,
and the grid virtualizes every row and column away without one), a
no-op `Element.prototype.scrollIntoView`, and a shim that rewrites the
CSS-nesting `&` selectors the grid uses into `:scope` (jsdom's selector
engine throws on them). Don't delete those shims to "clean up" the setup
file — the grid's component tests stop rendering anything without them.

## Workspace layout and setup

```
frontend/
  package.json          # workspace root (workspaces: apps/*, packages/*)
  apps/admin/            # the admin UI
  packages/shared/       # framework code shared across apps
```

`npm install` from `frontend/` installs both packages. Per-package
commands (`dev`, `build`, `test`, `test:e2e`) are run from that package's
own directory, e.g. `cd frontend/apps/admin && npm run dev`.

**`packages/shared` has no build step.** Apps resolve it directly from
TypeScript source via a Vite `resolve.alias` (in each app's
`vite.config.ts`/`vitest.config.ts`) and a matching `tsconfig.json`
`paths` entry — never through `node_modules` package resolution, and
never through a bundled `dist/`. Do not add a bundler step to
`packages/shared`; if you add a new app that depends on it, copy the
alias/paths pattern from `apps/admin`'s configs rather than inventing a
build.

## Running the admin app locally

```bash
# Terminal 1 — backend
cd server && .venv/bin/python -m tournament_server.main
# Terminal 2 — frontend dev server (proxies /api and /ws to the backend)
cd frontend/apps/admin && npm run dev
```

The dev server's proxy target port is read from `VITE_BACKEND_PORT`
(default `8000`, matching the backend's own default) — see
`vite.config.ts`. `npm run build` produces `dist/`, which the backend
serves directly in production (no dev proxy needed there).

## Bootstrap ordering (why the router looks the way it does)

`POST /api/event` and `GET /api/event` are unauthenticated on the
backend — no role credentials exist until an event is created, so
there's no way to log in before then. The admin app's router therefore
checks "does an event exist yet?" *before* any token check (a root
loader that redirects to `/events/new` on a 404), never nested inside
the authenticated layout. If this read backwards to you, it's covered in
detail in the design spec's "Routing & guards" section — don't
"simplify" this back to a token-check-first design; it was tried and
breaks a fresh install completely (the user could never reach the one
screen that lets them create an event).

Ahead of even the event check comes the picker check: `router.tsx`'s
`isPickerMode()` calls `GET /api/picker/directories` and treats a 404 as
"not in picker mode" (that route only exists in the picker app the
backend builds when no tournament is resolved yet — see
`server/CLAUDE.md`'s "Tournament picker" section) and any successful
response as "still picking." Every loader that isn't the picker route
itself checks this first and redirects to `/picker` if true, so a
freshly-installed server with no tournament chosen at all lands on the
picker screen before either the event check or a token check ever runs.

`useRestartPoll` (`src/useRestartPoll.ts`) is what a picker action
(create/open/switch) waits on afterward — each of those endpoints
restarts the backend process (a real `os.execve`, not a reload the
frontend can just await), so the hook polls `GET /api/picker/directories`
every 500ms (15s timeout) until the *target* app state is reached, then
calls `onReady` (default: `window.location.reload()`). Which response is
"ready" depends on which direction the restart is going, via its second
argument (`RestartTarget`, default `"normal"`): create/open go from
picker mode into the normal app, so readiness is the route going back to
404 (`PickerRoute.tsx`'s default `useRestartPoll()` call); "Switch
Tournament" (`AppShell.tsx`) goes the other way, normal app back into
picker mode, so it passes `"picker"` and readiness is the route
responding successfully again instead. Reusing the `"normal"` (404)
condition for the switch direction is a real, easy-to-reintroduce bug,
not just a hypothetical one — the *old*, still-normal process already
404s that route before it even restarts, so waiting on a 404 there fires
`onReady` immediately, before the restart has actually happened, and the
UI reloads back into the stale still-normal app instead of the
newly-restarted picker one.

## Auth & token handling

Both the access token and the rotating refresh token live in
`localStorage` (`packages/shared/src/tokenStorage.ts`). A silent
background timer refreshes the access token ~30 seconds before it
expires; `api-client.ts` also refreshes reactively on any `401` and
retries once. `refresh.ts` intentionally calls the raw `fetch` API
directly rather than going through `api-client.ts` — this breaks a
would-be recursion (api-client's 401 handler calls `refreshTokens()`; if
`refreshTokens()` itself used `api-client`, a 401 on the refresh
endpoint could call back into itself). `refresh.ts` also coordinates
concurrent callers onto a single in-flight request, since the backend's
refresh token is single-use (one-shot rotation) — without that, two
requests failing with 401 around the same moment would both try to
redeem the same now-stale refresh token, and only one would succeed.
Explicit logout always calls `POST /api/auth/logout` (server-side
revocation) before clearing local state, and always clears local state
even if that call fails.

## Testing

Unit/component tests: Vitest + React Testing Library, run via `npm test`
in each package/app. E2E: Playwright, run via `npm run test:e2e` from
`frontend/apps/admin/` — this starts both the real backend
(`python -m tournament_server.main`, via `playwright.config.ts`'s
`webServer` entries, against a temp-file SQLite DB) and the real Vite
dev server, and drives the actual built UI in a real browser. No mocking
at the HTTP/WebSocket boundary, consistent with the rest of this
project's testing policy.

**All E2E spec files share one backend process and one event** (this
project's single-event-per-process model), so they all import a shared
`E2E_EVENT_NAME`/`E2E_EVENT_PASSWORD` pair from
`tests/e2e/fixtures/testEvent.ts` rather than each assuming its own —
whichever spec file actually runs first creates the event, and every
other file's `beforeAll` tolerates the resulting `409` and logs in with
the same shared password. `playwright.config.ts` pins `workers: 1` and
`fullyParallel: false` so this ordering is deterministic
(`bootstrap.spec.ts` — the only spec that tests the fresh-install flow —
needs to run before an event exists). If you add a new E2E spec file
that needs the event to exist, import the shared constants; do not
invent a new password.

`playwright.config.ts` uses `channel: "chrome"` — the machine's installed
Google Chrome — rather than Playwright's own managed Chromium download,
because `npx playwright install` fetches its browser build from
`cdn.playwright.dev`, which stalls or times out on restricted-network
sandboxes (confirmed in this project's own dev environment) even though
small requests to the same host succeed. This means `npm run test:e2e`
needs Google Chrome installed on whatever machine runs it, but needs no
separate `playwright install` step. If your machine doesn't have Chrome
and does have normal internet access, switch `channel: "chrome"` back to
the default (remove the `channel` option, then run
`npx playwright install chromium` once).
