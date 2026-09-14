# Admin UI Shell & Event/Plugin Setup — Design

## Purpose

This is the first of six planned sub-projects that together make up the
Admin UI (the others: team/division/scheduling management; live match
control dashboard; finals brackets; device admission; rankings/reporting —
each gets its own brainstorm → spec → plan → implementation cycle). It is
also the first frontend surface built for this project at all — no
frontend code exists yet.

This sub-project delivers a working, deployable admin app that stops at
"a configured, plugin-selected event": login, app shell/layout/navigation,
event creation, role password management, plugin install + selection, and
the LAN-discoverability QR display. It explicitly does **not** cover team,
division, or session creation — that is the next sub-project.

It also establishes shared infrastructure (API client, auth/token
handling, i18n setup, real-time WebSocket hook) that the future scorer UI
will reuse, so getting the auth/token design right here matters beyond
this one app.

## Scope boundary

**In scope:**
- Login (role + password) and logout
- Silent access-token refresh (no forced re-login mid-session)
- App shell: header, navigation, WCAG 2.1 AA compliant layout
- Event creation (name + role password set on creation)
- Role password management (change a role's password)
- Game plugin install (zip upload) and selection for the event
- Scheduler plugin install (zip upload) — selection is out of scope here
  because scheduler selection happens at session-creation time, which
  belongs to the next sub-project
- `GET /api/server-info` QR code display (LAN discoverability)
- i18n scaffolding (English + Chinese), with all UI strings in this
  sub-project translated

**Out of scope (future sub-projects):**
- Team, division, session creation and management
- Live match control dashboard
- Finals brackets
- Device admission UI
- Rankings/reporting UI

## Stack

- **Language:** TypeScript
- **Build tool:** Vite
- **UI framework:** React
- **Routing:** React Router (data routers, with `loader`-based auth/event
  guards)
- **Server state:** TanStack Query
- **Client/session state:** React Context (`AuthContext`)
- **i18n:** react-i18next, English + Chinese locale JSON files
- **Component testing:** Vitest + React Testing Library
- **E2E testing:** Playwright, run against the real FastAPI test server
  and a real built/dev frontend — no mocking at the HTTP/WebSocket
  boundary, per this repo's testing policy

## Workspace layout

```
frontend/
  package.json                 # npm workspace root
  apps/
    admin/
      package.json
      vite.config.ts
      src/
        main.tsx
        routes/
          root.tsx              # authenticated layout route (AppShell)
          login.tsx
          events-new.tsx
          event-setup.tsx       # plugin install + selection, QR display
          settings-roles.tsx    # role password management
        pages/                  # one component per route above
        components/
          AppShell.tsx
          DebugEventPanel.tsx
        i18n/
          en/admin.json
          zh/admin.json
      tests/
        e2e/                    # Playwright specs
        unit/                   # Vitest specs
  packages/
    shared/
      package.json
      src/
        api-client.ts
        auth.ts
        realtime.ts
        i18n.ts
      tests/
```

`packages/shared` has no dependency on `apps/admin` — it is written so the
future scorer UI can depend on it identically. `apps/admin` is the only
consumer today.

## Backend contract (already implemented, referenced here for precision)

All endpoints below already exist server-side; this sub-project only
builds the client against them.

- `POST /api/auth/login` — body `{role, password, label?}` → `TokenResponse
  {access_token, refresh_token, expires_in}`. No auth required.
- `POST /api/auth/refresh` — body `{refresh_token}` → new `TokenResponse`.
  Rotates: the old refresh token is revoked server-side as part of this
  call.
- `POST /api/auth/logout` — body `{refresh_token}` → `204`. Revokes the
  matching session server-side.
- `PATCH /api/auth/passwords/{role}` — body `{password}` → `204`. Admin
  only.
- `POST /api/event` — body `{name, password}` → `EventRead`. Creates the
  (single) event and sets its role password set. Admin only.
- `GET /api/event` — → `EventRead {id, name, active_session_id,
  game_plugin_name, created_at}`.
- `POST /api/event/game-plugin` — body `{name}` → `EventRead`. Admin only.
- `GET /api/plugins/games` / `POST /api/plugins/games` (multipart zip
  upload) — list / install game plugins. Admin only.
- `GET /api/plugins/schedulers` / `POST /api/plugins/schedulers`
  (multipart zip upload) — list / install scheduler plugins. Admin only.
- `GET /api/server-info` — → `{port, addresses}`. Admin only. Used to
  render the LAN QR code (`http://<address>:<port>`).
- `GET /api/time-sync` — → `{server_time}`. No auth. Not used by this
  sub-project's own screens, but the shared client exposes it since the
  live-match-control sub-project will need it.
- `GET /ws/active-session` — WebSocket, authenticated via `?token=<JWT>`
  query parameter. This sub-project wires the connection and cache
  invalidation plumbing in `packages/shared/realtime.ts` but has no screen
  that visibly reacts to it yet (no live match state exists this early);
  the next sub-project is the first real consumer.

The 6 roles are `admin`, `scorer`, `judge`, `referee`, `attendee`,
`display_device`. This sub-project's screens (event creation, plugin
management, role passwords, server info) are all admin-only; the login
screen itself accepts any role (so the same shell/login flow is reusable
by the future scorer UI), but non-admin roles landing here today will see
only the login screen succeed and then have nothing else to do — that's
expected and acceptable, since this app's remaining screens don't exist
yet for them either.

## Auth & token handling

**Storage:** both the access token and the rotating refresh token are
stored in `localStorage`, under the `shared/auth` module's control. This
is necessary because rotation requires the refresh token to survive page
reloads; once it is already in `localStorage`, keeping the access token
in-memory-only buys negligible additional security while reintroducing
the "logged out on every page reload" problem.

**Silent refresh:** `shared/auth` starts a timer on login (and on app
load, if a valid token pair is already in `localStorage`) that calls
`POST /api/auth/refresh` a fixed margin before `expires_in` elapses (30
seconds early), swapping in the new `{access_token, refresh_token}` pair
with no user-visible action. `api-client` also triggers a refresh
reactively: any request that comes back `401` triggers one refresh
attempt, then retries the original request once. If refresh itself fails
(e.g. the refresh token was revoked or expired), `shared/auth` clears
`localStorage` and the app redirects to `/login`.

**Explicit logout:** calls `POST /api/auth/logout` with the current
refresh token (server-side revocation) and only then clears
`localStorage` and redirects to `/login`. If the logout request fails
(e.g. network error), `shared/auth` still clears local state and redirects
— a user asking to log out should always end up logged out locally, even
if the server-side revocation didn't get through — but it does not retry
the network call, since retrying a fire-and-forget revocation on an
already-abandoned session isn't worth the added complexity here.

**Page/route gating:** the built static assets (`index.html`, JS, CSS) are
served unauthenticated — there is no session-cookie gate on the SPA shell
itself. All real access control happens (a) client-side: a React Router
`loader` on the authenticated layout route checks for a token in
`localStorage` and redirects to `/login` if absent or invalid, and (b)
server-side: every API endpoint this UI calls is already bearer-token and
role gated, independent of anything the client does. This resolves the
open question from the core architecture spec (line ~459-463 of
`2026-08-28-core-server-plugin-architecture-design.md`) in favor of
bearer-token-only gating — no session cookie, since the SPA is static
assets with no server-rendered per-user page.

**JWT signing key:** out of scope for this sub-project (already resolved
by the existing `real-authentication` implementation — the server
generates/reads a signing key at startup; no frontend concern).

## Routing & guards

React Router data router with two top-level branches:

- `/login` — public, no guard. On successful login, navigates to `/`.
- Authenticated layout route wrapping everything else, rendering
  `AppShell`:
  - `loader` redirects to `/login` if no valid token pair exists in
    `localStorage`.
  - Nested under it, a second `loader` (on an "event configured" wrapper
    route) checks `GET /api/event`; a 404 (no event yet) redirects to
    `/events/new`, otherwise renders the requested child route.
  - `/` — dashboard/home (minimal for this sub-project: event name,
    active session summary placeholder, links to setup screens)
  - `/events/new` — event creation form
  - `/events/:id/setup` — plugin install + selection, server-info QR
    display (`:id` is always the single event's id; included for route
    clarity and future-proofing rather than because multiple events
    exist)
  - `/settings/roles` — role password management

## Data flow

Server state (event, plugin lists) is fetched via TanStack Query hooks
that call `shared/api-client`. Mutations (create event, install plugin,
select plugin, change password) use Query mutations and invalidate the
relevant query keys on success (`['event']`, `['plugins', 'games']`,
`['plugins', 'schedulers']`). Auth/session state (current role, whether
logged in) lives in `AuthContext`, populated from `shared/auth` on app
load and updated on login/logout. The WebSocket hook
(`shared/realtime.ts`) is initialized once a valid token exists and is
wired to invalidate the same query keys on the relevant events from the
event catalog in `server/CLAUDE.md` (`active_session_changed`, etc.) —
plumbing only in this sub-project, since no screen here has live state to
refresh yet.

## Error handling

- **Form validation errors** (e.g. duplicate plugin name, weak password):
  surfaced inline near the relevant field, using the API's error `detail`
  text.
- **Transient/network errors:** a dismissible banner in `AppShell`.
- **401 surviving a refresh attempt:** forces logout (clears
  `localStorage`) and redirects to `/login`.
- **Plugin install failure** (`409` already exists, `422` invalid zip):
  shown inline on the upload form with the server's `detail` message.
- **WebSocket disconnect:** a small "reconnecting…" indicator in
  `AppShell`; the hook reconnects with exponential backoff and refetches
  active queries on reconnect (no resync protocol needed — matches the
  backend's REST-refetch design).

## Accessibility

WCAG 2.1 AA is a hard requirement for this UI (per `PRODUCT.md`). Concrete
implications for this sub-project: semantic landmarks in `AppShell`
(`<nav>`, `<main>`, `<header>`), visible focus states, form fields with
associated `<label>`s and error text wired via `aria-describedby`, and
sufficient color contrast in whatever visual direction Impeccable's
design pass produces (checked via `impeccable audit` / axe as part of
that pass, and spot-checked manually here).

## i18n

`shared/i18n.ts` configures react-i18next with English and Chinese
resource bundles. Every user-facing string in this sub-project's
components goes through `useTranslation()` from the start — no
hard-coded English strings deferred for later extraction. Locale files
live per-app (`apps/admin/src/i18n/en/admin.json`,
`apps/admin/src/i18n/zh/admin.json`); `shared/i18n.ts` provides the
react-i18next setup/init function that each app calls with its own
resource bundles, so the scorer UI can supply its own translations
through the same mechanism later.

## Testing

**Unit/component (Vitest + React Testing Library):**
- `shared/auth`: token storage round-trip, silent-refresh timer
  scheduling, 401-triggered reactive refresh, logout clearing state
  even when the server call fails.
- `shared/api-client`: bearer token attached to requests, single retry
  after refresh, typed error thrown on non-2xx.
- Form components: validation error rendering.

**E2E (Playwright, against a real FastAPI test server + real frontend
build):**
- Golden path: log in as admin → create event → install a game plugin →
  select it → see it reflected in the shell/dashboard.
- Bad login credentials show an inline error.
- Session nearing expiry silently refreshes (simulated via a short-lived
  test token) without the user being prompted to log in again.
- Explicit logout revokes the refresh token server-side (verified by
  attempting to reuse it against `/api/auth/refresh` and asserting
  failure) and redirects to `/login`.
- No event configured yet → landing on `/` redirects to `/events/new`.
- Role password change takes effect (old password rejected, new password
  accepted on next login).
- Debug event panel: with the panel open, triggering `active_session_changed`
  via a direct API call to `POST /api/event/active-session` (this
  sub-project's UI has no session-creation screen yet, so the test drives
  the backend directly, as an out-of-band setup step, while asserting on
  the browser) causes a new entry to appear in the panel showing that
  event type and payload.

## Debug event panel

Since this sub-project wires up the real-time WebSocket connection
(`shared/realtime.ts`) with no screen yet that visibly consumes its
events, a small debug panel doubles as the first real proof the
connection works end-to-end and as an E2E-testable signal that events
arrive, without instrumenting internals.

`DebugEventPanel` is a collapsible panel rendered inside `AppShell`,
visible only to the `admin` role. It subscribes to the same
`useRealtimeChannel()` hook everything else uses (no separate WebSocket
connection) and keeps an in-memory ring buffer of the last 50 events
received this session (cleared on refresh — no persistence). Each entry
shows a timestamp, the event type, and its raw JSON payload
(pretty-printed, scrollable). Collapsed by default; a badge shows the
count of events received since last opened. This is a development/support
aid, not a product feature — no i18n strings beyond a static "Debug
events" toggle label, and no styling investment beyond basic legibility.

## Non-goals for this sub-project

- No team/division/session UI (next sub-project).
- No live match control UI (later sub-project) — the WebSocket hook is
  wired but has no live-data screen to drive yet.
- No visual/UX design decisions are made in this spec — Impeccable's
  `shape`/`craft` flow handles the actual look and feel on top of this
  technical foundation once implementation begins.
