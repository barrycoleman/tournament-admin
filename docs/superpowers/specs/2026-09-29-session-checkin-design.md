# Session Check-In Admin UI Design

## Context and motivation

The tournament-admin server's backend fully supports `TournamentSession`s, `SessionParticipation` (team check-in), `FieldSet`/`Field` management, and multi-round schedule generation (see `docs/superpowers/specs/2026-09-26-multi-round-scheduling-design.md`), but none of it has any admin UI yet — the frontend only has Dashboard, Event & Plugins, Role Passwords, Divisions, and Teams screens (`frontend/apps/admin/src/routes/`). Nothing downstream (match scoring, rankings, finals) is reachable without a session existing and teams being checked into it, so this is the natural next UI to build.

This spec was originally scoped as "Sessions + Fields + Schedule-generation UI," but during design it became clear that piece decomposes into two independent sub-projects: this one (Sessions CRUD + team check-in) and a later one (Fields + Schedule-generation form + Matches view), which depends on Sessions existing but not on anything in this spec. This spec covers only the first.

During design, a further scope question emerged — the user wants the admin check-in view to also show/set robot inspection status. That grew into a genuinely separate subsystem (question-set templates, per-team notes, an event-level enable/disable toggle, a referee-facing checklist UI, an admin-override rule) that doesn't fit inside this spec. It has been captured as its own deferred idea (see the `inspections-subsystem-deferred` memory) and will be brainstormed as its own sub-project once this one ships — this spec's check-in tab is scoped to check-in only, with no inspection concept.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real FastAPI `TestClient` and real temp-file SQLite, in the same commit as the code.
- Every frontend change ships with Vitest component tests and, for user-facing flows, Playwright E2E coverage — no mocking at the HTTP/WebSocket boundary for E2E.
- No destructive migrations. No schema change may destroy existing data.
- Every user-facing string goes through `useTranslation()`/`t(...)` in both `en`/`zh` `admin.json` files — no bare string literals.
- Follow this app's existing conventions rather than inventing new ones: TanStack Query for server state, the `InlineEditableText` optimistic-update-with-inline-error pattern for editable fields, `react-data-grid` (with the shims `frontend/CLAUDE.md` documents) for spreadsheet-style tables, native `<input type="date">`/`<select>` for date/timezone entry.

---

## Section 1: Routing and layout

A new `NavLink to="/sessions"` is added to `AppShell.tsx`, positioned after Divisions/Teams, visible only for the `admin` role (matching the existing `role === "admin"` conditional pattern already used for other admin-only nav items).

Routes, all under the existing `AuthenticatedLayout`:

- `/sessions` — `SessionsRoute`: list of sessions + create action.
- `/sessions/:sessionId` — index-redirects to `/sessions/:sessionId/checkin`.
- `/sessions/:sessionId/checkin` — `SessionCheckinRoute` (this spec's main deliverable).
- `/checkin` — `FrontDeskCheckinRoute`, a separate, non-nested route (not under any session id in its URL — see Section 5).

A new `SessionDetailLayout` component fetches the session once via `useQuery(["session", sessionId], ...)`, renders a header (label, optional nominal date, timezone) and a sub-nav tab strip, then `<Outlet context={{ session }} />` so child routes read the already-fetched session via `useOutletContext()` rather than re-fetching it. This spec only populates the "Check-in" tab; the tab strip itself is built now so the later Fields/Schedule-generation/Matches sub-project only has to add tabs, not build the strip.

All new strings go into the existing single `frontend/apps/admin/src/i18n/en/admin.json` (+ `zh/admin.json`) under a new top-level `sessions` key.

---

## Section 2: Sessions list and CRUD (`/sessions`)

A list screen — sessions are few per event (typically one per competition day), so a plain table is used, not a data grid:

- Columns: **Label**, **Date** (the session's optional nominal `session_date`, "—" if unset), **Timezone**, each row linking to `/sessions/:id/checkin`.
- A "New Session" form (small modal/inline form, not a separate route), with:
  - **Label** (required text).
  - **Timezone** (optional `<select>`, populated from `Intl.supportedValuesOf("timeZone")` — a real, currently-supported browser API; safe here since this project's Playwright config already pins a real installed Chrome). Required only once real `time_blocks`-based scheduling is used later; may be left unset.
  - **Nominal date** (optional `<input type="date">`) — purely for display/sorting; the backend's Phase 2 scheduling redesign already made `session_date` non-load-bearing for scheduling itself.
- Editing an existing session reuses the same form fields via the `InlineEditableText` pattern (click to edit, Save/Cancel), calling a **new** `PATCH /api/sessions/{id}` endpoint (see below) — the backend today only has `POST`/`GET /api/sessions`.

### Backend addition: `PATCH /api/sessions/{id}`

- Request body: `{label?: str, session_date?: date | null, timezone?: str | null}` — every field optional, only provided fields are updated (matching the partial-update convention `PATCH /api/teams/{id}` already uses).
- `admin`-only (`require_admin`), 404 if the session doesn't exist.
- No validation beyond what `POST /api/sessions` already applies to the same fields (e.g. `timezone` isn't validated as a real IANA zone at write time today — this spec does not change that; a bad value only surfaces later, when `POST /api/schedule` tries to resolve it via `ZoneInfo`, exactly as today).

---

## Section 3: Admin check-in tab (`/sessions/:id/checkin`)

A `react-data-grid`-based view (same library/shim setup as `TeamsRoute`, for "at a glance" fast scanning of a full roster):

- Columns: **Number**, **Name**, **Division** (only shown if the event has more than one division), **Checked In**.
- The **Checked In** column is a custom `renderCell` (not `renderEditCell` — a checkbox is always directly clickable, so it never needs the grid's edit-mode machinery) rendering a checkbox/toggle that fires the check-in mutation immediately on click.
- A text filter box above the grid (filters visible rows by number or name) and a default sort by division then team number.
- "Check in all visible" / "Check out all visible" bulk actions, operating on whatever the current filter shows — the common case is checking in one whole division at a time. No new bulk backend endpoint is introduced for this: the frontend issues one `POST /api/sessions/{id}/participants` call per visible team (the same upsert-capable call a single toggle makes), and invalidates the participants query once after all of them settle.
- Row data: `GET /api/teams` merged client-side against `GET /api/sessions/{id}/participants` (join on `team_id`; a team with no participation row shows as unchecked). Toggling calls `POST /api/sessions/{id}/participants` (see the upsert fix below) and invalidates the participants query key on success.
- This tab is named **Check-In**, not "Team Status" — a broader rename is left for the future Inspections sub-project, if and when it adds a second column here.

---

## Section 4: `front_desk` role and backend fixes

Two real backend gaps surfaced during design, both needed for Section 5's dedicated screen to work at all:

### `POST /api/sessions/{id}/participants` must become an upsert

Today this endpoint always does a bare `INSERT`, relying on a `UniqueConstraint` and catching `IntegrityError` to return 409 — so checking a team in, then trying to check the same team in again (or toggling it back on after unchecking it), currently 409s instead of succeeding. This blocks the explicit requirement that a team already checked in must show as checked in when the front-desk screen looks them up again, not error.

**Fix:** `add_participant` looks up the existing `(session_id, team_id)` row first; if found, it updates `checked_in` in place; otherwise it inserts a new row, exactly as before. No schema change — this is a logic fix inside the existing endpoint. `list_participants` (`GET`) is unchanged.

### New `front_desk` role

- `auth.py`: `ROLES` gains `"front_desk"`. A new `require_admin_or_front_desk = require_role("front_desk")` dependency (matching the existing `require_scorer_or_referee` convention — `admin` always passes any `require_role(...)` gate automatically, so it's never listed explicitly).
- `add_participant`'s auth dependency changes from `require_admin` to `require_admin_or_front_desk`. `list_participants` stays `require_any_role`, unchanged — `front_desk` (like every other role) can already read.
- `POST /api/event`'s existing per-role `RoleCredential` seeding loop (`for role in ROLES: ...`) needs no change — it already iterates the tuple, so any **new** event automatically gets a `front_desk` credential the moment this role exists.
- **Startup self-heal for existing events:** `create_app()`'s existing self-heal step (which currently calls `assign_sole_division` for every event) gains a sibling step that, for every existing `Event`, backfills a `RoleCredential` row for any role in `ROLES` that event doesn't already have one for. This is written generically (iterate `ROLES`, not hardcoded to `"front_desk"`) so the *next* role this project ever adds self-heals the same way, for free. Idempotent and cheap, run on every startup, matching the existing self-heal's own pattern exactly. A backfilled row's initial password is copied from that event's current `admin` `RoleCredential` (both `password_hash` and, if present, `password_encrypted`) — mirroring `POST /api/event`'s own original behavior of every role starting from one shared password until an admin differentiates them via Settings > Role Passwords. This is a one-time bootstrap value only; the admin is expected to set a real, distinct `front_desk` password afterward the same way they would for any other role.
- Frontend: `SettingsRolesRoute.tsx`'s hardcoded `ROLES` array (confirmed duplicated from the backend's, not fetched dynamically) gains `"front_desk"`, so an admin can set/reveal its password the same way as every other role. `LoginRoute.tsx` needs no change — its role field is free text, not a fixed list, so a `front_desk` login already works there today.

---

## Section 5: Dedicated front-desk check-in screen (`/checkin`)

A separate, minimal route for use by front-of-house staff who are not full admins:

- `AppShell.tsx`'s nav is extended: when logged in as `front_desk`, the shell shows **only** a "Check-In" link to `/checkin` (mirroring the existing `role === "admin"` conditional — the same component, a different role check, producing a stripped-down shell rather than a wholly separate app).
- The screen is scoped to the event's **active session** (`Event.active_session_id`, an existing concept already used elsewhere in this codebase, e.g. the active-session WebSocket channel) — front-desk staff don't pick a session, they work whichever one is currently active. If no session is active, the screen shows a clear empty state ("No active session — ask an admin to set one") instead of erroring or showing stale data.
- Layout, designed for quick, low-attention use at a check-in table: a large search box (filters by team number or name as-you-type) over a large-touch-target list. Each visible row shows the team's number/name and a single large button: "Check In" (default) or a filled "✓ Checked In" state once toggled. Clicking a "✓ Checked In" row's button again is a no-op in the UI (already checked in), not a toggle-off — un-checking a team is an admin-only action via the Section 3 grid, not something front-desk staff do from this screen.
- Reads the same merged teams+participants data Section 3's grid uses, so a team checked in from either screen is immediately correct on the other (both invalidate the same `["participants", sessionId]` query key).
- Left with room, but not built, for a future read-only inspection-status column — the Inspections sub-project's own design will decide how that's laid out; this spec does not reserve specific markup or props for it.

---

## Testing strategy

- **Backend:** pytest integration tests (real `TestClient` + temp-file SQLite) for: `PATCH /api/sessions/{id}` (partial updates, 404 on missing session, each field independently and together); the participation upsert fix (check in, check in again — must succeed and leave one row, not 409; check in then check out then back in); the `front_desk` role's auth gate on `POST .../participants` (front_desk succeeds, every other non-admin role still 403s); the startup self-heal (an event missing a `front_desk` `RoleCredential` row gets one backfilled on `create_app()`, an event that already has one is untouched, idempotent across repeated calls).
- **Frontend:** Vitest component tests for `SessionsRoute`, `SessionDetailLayout`, `SessionCheckinRoute` (the grid, filter, bulk actions, the checkbox cell), and `FrontDeskCheckinRoute` (search, check-in button states, the no-active-session empty state). Playwright E2E: create a session → check in several teams via the admin grid → log out → log in as `front_desk` → confirm the same teams show checked-in on `/checkin` → check in one more team from `/checkin` → log back in as admin → confirm the grid reflects it. A second E2E covers the `front_desk` nav restriction (only "Check-In" is visible/reachable) and the no-active-session empty state.

## Out of scope (explicitly deferred, not built in this spec)

- Fields/FieldSets management, the schedule-generation form (phases, time blocks, dry-run preview), and the generated-matches view — a separate, later sub-project spec, built against Section 1's routing/tab-strip foundation.
- The full inspection-tracking subsystem (question-set templates, per-team notes, event-level enable/disable, referee checklist UI, admin override, the "can't inspect a non-checked-in team" constraint) — see the `inspections-subsystem-deferred` memory. This spec's check-in tab has no inspection concept at all.
- Deleting a session — cascade behavior for a session with matches/rankings already attached isn't designed; out of scope here.
- Import/export of anything — not applicable to this spec (raised only in the deferred inspections context).
