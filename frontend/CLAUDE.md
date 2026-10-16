# Frontend instructions for Claude Code

## What this is

The tournament-admin project's frontends live here as an npm workspace:
`frontend/apps/<app>/` (one per UI surface — currently `admin` and
`device`, the app a paired tablet or TV runs) and
`frontend/packages/shared/` (auth/token handling, the API client,
real-time WebSocket hook, and i18n setup — written once, shared by every
app). Each app builds to static assets the Python server
(`server/`) serves directly — see `server/CLAUDE.md`'s "Serving the admin
UI" section for how that wiring works. The admin app is served at `/`,
the device app at `/device/` (its Vite `base`), and the server answers
`/pair` with a 307 to `/device/`, so a TV only types a short address.

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
pass the library's own `renderTextEditor`). Its `width: "max-content"` is measured once, from whatever rows are
rendered then (often none), so the roster sizes its columns itself:
`src/gridColumnWidth.ts` works out each column's minimum and ideal width
from every row, and shares the grid's measured width
(`useContentWidth`) out, giving spare room only to columns with data.
`papaparse` does double duty:
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
  apps/device/           # the paired-device app (base /device/)
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

**A deployment needs both apps built.** The server serves
`apps/admin/dist/` and `apps/device/dist/` side by side; without the
device build, `/pair` redirects to `/device/`, which 404s. Run
`npm run build` from `frontend/` (the workspace script builds every app),
or `npm run build` in `apps/admin` and in `apps/device`.

To work on the device app too, start its dev server as well (Terminal 3:
`cd frontend/apps/device && npm run dev -- --port 5175`). The admin dev
server proxies `^/device/` and `^/pair/?$` (rewritten to `/device/`) to
it, on the port in `VITE_DEVICE_PORT` (default `5175`), so in
development, as in production, both apps share one origin and the
pairing QR link and `/pair` work from the admin dev URL. Keep the device
key anchored with its trailing slash: a plain `/device` prefix would also
catch the admin's own `/devices` page and hand it to the device server.

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

## Routes and role-gated nav

Beyond the bootstrap/auth screens above, the authenticated app
(`router.tsx`, under `AuthenticatedLayout`) has: `/sessions` (list +
create/edit, plus per-row Set active and Delete; Delete is disabled with a
`title` explaining why when `SessionRead.has_scored_matches`, and otherwise
asks for the session's name in `ConfirmDialog`), `/sessions/:sessionId` (index-redirects to
`/sessions/:sessionId/checkin`), `/sessions/:sessionId/{checkin,fields,schedule,matches,skills,rankings}` (the session
tabs, all rendered through `SessionDetailLayout`'s tab-strip `Outlet`
context — see the session-checkin and fields-schedule-ui design specs;
the layout's header also carries the "Set as active session" control; the Fields tab's empty state offers "copy fields from" any other session that has field sets, via `POST /api/sessions/{id}/copy-fields`), and `/checkin` (a
separate, non-nested route: the dedicated `front_desk` kiosk screen,
scoped to `Event.active_session_id` rather than a session id in the
URL). Admins also have `/devices` (pair and manage tablets and displays;
see **Devices** below). `/device/` and `/pair` are not admin routes: they
belong to the device app, and the admin dev server proxies them to it.

The Schedule tab is a live planner. `src/schedule/planDraft.ts` (rows,
change detection and `isDraftDirty`, what Apply sends — the first
new/changed/needs-rebuild row and every row after it — default cycle
times, and merging a server refresh into the draft), `playingWindows.ts`,
`timeline.ts`, `roundSummary.ts` and `readiness.ts` are pure and
unit-tested. `SessionScheduleRoute` loads session-wide data, shows
readiness blockers and the division tabs, and renders one `DivisionPlanner`
per division (keyed by division, so switching tabs resets its draft after
a discard prompt). It mounts the planner only once both the match format
and the playing windows have loaded, because `PlayingTimesPanel` seeds its
editor from the windows on first render. The readiness "Add playing
times" link is a same-page anchor that scrolls to and focuses
`#playing-times` itself, since client-side navigation wouldn't.
`DivisionPlanner` owns the draft (`usePlannerDraft`, dirty when a scheduled
row is edited or a new row is added, removed or edited relative to the
suggestions it started with), sends it as a dry run 400 ms after the last
edit (`usePlanPreview`, keyed by the request body), and renders
`PlayingTimesPanel` (with `PlanTimeline`), `RoundsTable`, `FitStatus` and
the Generate/Apply button, which stays disabled until the latest dry run
says the plan fits. `RoundsTable`'s cycle inputs (`CycleInputs`) keep the
text as typed and only re-sync from the row when `parseCycle` of that text
no longer equals it. Anything that changes playing times or clears a round
(`PlayingTimesPanel`, the extend action, `ClearRoundDialog`) invalidates
`["schedulePlan"]` too, because an identical request body would otherwise
reuse a stale answer. The extend action's PUT replaces every window, so it
first re-fetches the windows and, if they no longer match the ones the
overflow was checked against, sends nothing and re-checks instead (so it
never overwrites another admin's edit); "Use cycle time" and "Extend" are
disabled until the preview is settled. `useUnsavedChangesGuard` uses the data router's
`useBlocker` plus `beforeunload`. A single-division event never sends
`division_id` (the backend then uses unassigned FieldSets); a
multi-division event always sends the selected one. `useSessionMatches`
(`src/useSessionMatches.ts`) is the one `["matches", sessionId]` query both
the Schedule and Matches tabs share, kept live off `/ws/session/{id}`;
`DELETE /api/schedule` broadcasts nothing, so anything that clears a round
invalidates that key itself. Match times always render in the session's
timezone (`src/matchTime.ts`), never the browser's.

Qualification finalizing lives in `src/qualification/`: `QualificationBar`
(rendered above the Matches page's filter toolbar) offers Finalize, or the
blocker sentences when the server says it can't yet, or "finalized on ..."
with Reopen; `FinalizeDialog` collects per-played-count drops (pure logic in
`finalizeDraft.ts`). The preview query key is `["qualification-preview",
sessionId]`, kept live off `/ws/session/{id}`. The future Finals page must
disable its generate action while `qualification_finalized_at` is null, with
the message "Finalize qualification on the Matches page before generating
finals." and a link to `/sessions/{id}/matches`.

Rankings live in `src/rankings/`. `useRankingGroups(scope)` fetches every
division's rankings plus `division_id = null` (a single-division event's
scheduled matches carry no division) and returns only non-empty groups;
`RankingsView` renders them through `RankingTables`, with columns chosen by
`game_model` from `GET /api/ranking-settings` (`useRankingSettings`, key
`["rankingSettings"]`). The session Rankings tab invalidates
`["rankings", sessionId]` off `/ws/session/{id}`; `/rankings` (Season
rankings) invalidates
`["rankings", "season"]` off `/ws/active-session`, the only channel that
carries event-wide `ranking_updated`. Event Setup's `RankingSettingsPanel`
renders only for `cooperative_score`; its form logic (`settingsDraft.ts`) is
pure and unit-tested, and choosing a game plugin invalidates the settings
query so the panel appears without a reload.

Skills challenges live in `src/skills/`.
- **Settings:** `useSkillsSettings` (key `["skillsSettings"]`) drives everything. Event Setup's `SkillsSettingsPanel` is shown disabled, with the reason, until a game with skills types is chosen. Selecting a plugin invalidates that key, so it enables without a reload.
- **Skills page:** the session Skills tab (`SessionSkillsRoute`) appears only while skills are on. Opened directly while they are off, it says so and links to Event Setup. It holds:
  - `SessionAttemptsSettings`: the attempts line and the session override;
  - `RecordAttemptForm`: `TeamPicker` over checked-in teams (`["participants", sessionId]`, shared with Check-In), type buttons hidden for a one-type game, and the shared scoresheet;
  - `AttemptsTable`: the team filter, plus `EditAttemptDialog` for admin edit and delete.
- **Rankings:** both rankings pages use `RankingTabs`/`useRankingTabs` (Teamwork, each type, Overall Skills). A skills tab renders `SkillsRankingsPanel` (key `["skillsRankings", sessionId | "season", tab]`).
- **Live updates:** every skills event reaches `/ws/active-session`, so skills UI listens there through `useSkillsLiveUpdates` / `handleSkillsEvent`, mounted once in `SessionDetailLayout` (which also keeps the Skills tab live); session tabs must not mount it again.
- **Scoresheet forms:** they come from `@tournament-admin/shared`'s `ScoresheetForm`, which takes the caller's `t` (`useScoresheetT`) and knows nothing about skills. The future scorer app reuses it for skills and teamwork. A 422's per-field `violations` reach it through `ApiError.body` (`violationsByField`).

`AppShell.tsx`'s nav is gated per role, the same pattern repeated for
each: `role === "admin"` renders the full admin nav (Divisions, Teams,
Sessions, …); `role === "front_desk"` renders a separate, minimal `<nav>`
with just a Check-In link to `/checkin`. Adding a nav item for a new role
means adding another `role === "..."` block here, not extending an
existing one — the two blocks are deliberately not merged, since each
role's shell is meant to show only what that role can actually use.

`front_desk` additionally gets its own index-route redirect:
`routeGuards.ts`'s `indexLoader` (attached only to the `index: true`
child route under `/`, not the shared parent `rootLoader`) reads the
stored JWT directly (`getStoredTokens`/`decodeAccessTokenPayload` — the
same synchronous, context-free pattern `hasValidTokens()` already uses,
since loaders run outside the React tree and can't call `useAuth()`) and
redirects straight to `/checkin` if the role is `front_desk`, instead of
landing on the admin-only Dashboard (whose "edit event name" control
would otherwise 403 for that role). It's kept in its own module rather
than inlined in `router.tsx` specifically so it can be unit-tested
without importing `router.tsx` itself — that file's module-level
`createBrowserRouter(...)` call kicks off a real navigation attempt as
soon as it's imported, which isn't safe to trigger from a plain Vitest
unit test under jsdom.

**Match Control** (`src/routes/MatchControlRoute.tsx`, `src/matchControl/`, admin nav "Match Control", route `/match-control`): the operator page for the active session. One tab per field group (the choice remembered in the browser), each with a Next match card (the override from `PUT /api/field-sets/{id}/queued-match`, with Change and Clear), a Timer card (Start, Start Driver, Pause, Resume, End Early, which asks first, and Reset, which asks whether to reset the period or the whole match), a Saved Match card (the last fully scored match with its scores), one button per audience screen with the selected screen's settings below, a Time-out control (length and Cancel) and the Play sounds switch. The next-match rule is the shared one in `packages/shared/src/display/matchOrder.ts`, so the page and the displays agree. It refetches on the match, score, `display_changed` and `field_set_changed` events on `/ws/active-session`, so two admins see the same state.

**Displays** (`src/routes/DisplaysRoute.tsx`, `src/displays/`, admin nav "Displays", route `/displays`): for the active session, with a session picker to set up another. Field groups each show their audience group (screen and settings, Play sounds, its displays) and their fields' groups; pit groups are added with a name and division and edited in `PitGroupEditor` (one screen, or a rotation: an ordered list of screens with settings and, for screens that don't scroll, seconds; reorder, add, remove; delete asks first). Each display shows its name, online state, Identify and a Move to selector; unassigned displays have Put in group and Identify; Copy displays from another session is offered while the session has no pit groups or assignments and afterwards lists the displays it could not place. Screen labels are admin i18n keys, one per registry key. The Devices page also shows each display's group. The page refetches on `display_changed` and `devices_changed`.

**Awards** (`src/awards/`): the session Awards tab (`/sessions/:id/awards`) lists a session's awards in ceremony order with each slot's winners and status, and lets an admin add, edit, reorder, copy, delete, override, finalize and export them. `AwardsView` takes a `mode` (`admin` or `judge`) and a realtime `channelPath`, and refetches on `awards_changed` and on anything that moves a result (`AWARD_REFRESH_EVENTS`). Judges log into the same app and see only `/judge/awards` (judged awards, choose and clear winners), `/judge/rankings` (session rankings) and `/rankings`, always for the active session; `JudgeLayout` provides the session and the `/ws/active-session` channel, because the per-session channel is admin-only. `AuthenticatedLayout` sends a judge anywhere else back to `/judge/awards`.

**Game plugin gating** (`src/gamePlugin/`): until the event has a game plugin, `useGamePlugin` reports none, `GamePluginBanner` (in the admin layout, hidden from judges) links to `/events/setup#game-plugins`, and `RequiresGamePlugin` swaps a screen for `NeedsGamePlugin` (an admin gets a link to Event Setup, anyone else a plain note). `router.tsx` wraps session Matches, Rankings and Skills, season `/rankings` and `/judge/rankings` in it; award forms disable the Performance kind and any source that cannot produce a winner. `AppShell` calls `useGamePluginLiveUpdates`, which refetches everything the plugin shapes on the `game_plugin_changed` broadcast, so open pages unlock live. Event Setup's plugin section has three states: nothing selected ("Select for this event"), selected and unused ("Switch to this" and "Clear selection", each first asking the server for a `dry_run` preview and confirming what will reset in an `alertdialog`), and in use (matches or skills attempts exist: no buttons, just the locked note). The skills settings form re-seeds from server values that change under it, because a plugin change resets them.

**Devices** (`src/routes/DevicesRoute.tsx`, `src/devices/`, admin nav "Devices", route `/devices`): `PairDeviceForm` takes a code typed loosely (case, spaces and dashes are normalized), checks it as soon as it has six characters and fills in the server's suggested name (replacing only an earlier suggestion, never a name the admin typed), then pairs it with a role and name. The page reads `?pair=<code>` to prefill the form, which is what the device's QR link opens. The list shows each device's role, status (active, idle, disabled) and last seen, with Edit (`EditDeviceDialog`), Disable/Enable and Delete (`ConfirmDialog`); below it is the idle-timeout setting (15 to 1440 minutes). The list refetches on the `devices_changed` broadcast on `/ws/active-session`. A signed-out admin who opens `/devices?pair=...` returns there after signing in: `returnPathAfterLogin` in `routeGuards.ts` sends an admin back to the page they came from (and a judge only to a judge page) through `safeReturnPath`, which refuses anything but a same-app path. Only a signed-out visit or an expired session records that return path: clicking Log out calls `noteExplicitLogout()` first, so `AuthenticatedLayout` redirects to `/login` with no `from` (the page belonged to the user who left), and the next sign-in clears the flag. The sign-in page links to `/pair` with a plain `<a>`, not a router `Link`, because `/pair` belongs to the device app.

**Device app** (`apps/device/`): a small React app with no router, built with Vite `base: "/device/"`, which the server serves at `/device/` with its own SPA fallback. It keeps its device token under its own `localStorage` key `tournament-admin.device.v1` and makes every request through its own fetch helper in `src/deviceApi.ts`, never the shared `apiRequest`, and never reads or writes the admin's `tournament-admin.auth.v1` — the two apps share an origin, so pairing the browser an admin is signed into must leave the admin signed in. `useDeviceSession` picks one of three screens: pairing (`PairingScreen`: the code in two groups of three, a QR link to `/devices?pair=<code>`, a countdown and automatic renewal counted from the response's `expires_in` on the device's own clock, never by comparing `expires_at` with it, because a TV's clock may be wrong), home (`HomeScreen`: "Paired as" with the name and role), and blocked (`BlockedScreen`: "This device is disabled.", rechecked every 30 s). A sign-in refused as unknown clears the token and goes back to pairing; a server it can't reach shows "Can't reach the server. Retrying…" and retries. While signed in, `useDeviceSocket` holds `/ws/active-session` open; a `4403` close (the device was disabled, deleted or changed) makes it sign in again, which lands on the right screen. A device on the blocked screen holds no socket, so it notices being enabled or deleted only at its next 30 s recheck. A `1008` close (the server refused the socket) is handled like `4403`: the device signs in again, which rechecks its state. While the server is unreachable (a failed request or a socket that cannot connect or has dropped) the pairing, loading and home screens show the "Can't reach the server. Retrying…" banner; display mode shows a small corner badge instead, so the picture stays on screen. If `localStorage` refuses the device token (a private window, a full quota) `storeDeviceToken` keeps it in a module-level in-memory variable, so the page carries on and only a reload needs pairing again; `getDeviceToken` reads storage first and falls back to that variable.

**Display mode** (`apps/device/src/display/`, see the display groups design): a paired device whose role is `display_device` renders `DisplayApp` (TanStack Query provider, the event bus, the server clock, the screen frame) around `DisplayRoot` instead of the "Paired as" home screen; scorer, referee, judge and check-in devices keep that placeholder. `DisplayRoot` reads `GET /api/displays/me` and mounts, by group kind, `FieldDisplay` (a field group: Next Match with large alliance bars and the start-time colour bands, In Match, Match over, Done), the group's current screen (an audience group) or `RotationRunner` (a pit group, which also runs a single screen). `useDeviceSocket` hands every message to an event bus (`events.ts`; `RECONNECTED` is emitted on each socket open) and `useLiveRefresh` holds the live-event refresh map: each event invalidates the query keys it makes stale (`display_changed`, `field_set_changed` and `active_session_changed` refetch `me`; match, score, ranking, skills and finals events refetch their data), and a reconnect or `game_plugin_changed` invalidates everything. `display_identify` for this device shows its name full-screen for 10 s. `useServerClockOffset` measures the offset from `GET /api/time-sync` (half the round trip), re-measures every 10 minutes and on each reconnect, and every countdown uses `useServerNow`, because a TV's clock may be wrong. Times are shown in the session's time zone, never the TV's; a session with no time zone shows UTC labelled "UTC" (as the admin does), and a display waits only while the sessions are still loading. The screen registry is `src/display/screens/registry.ts`: one module per key from `@tournament-admin/shared`'s `ScreenKey` list, each exporting `{key, Component, scrolls}`; an unknown key (an older device app after a server update) shows Logo. Each screen fetches its own data from the existing REST endpoints. `useAutoScroll` scrolls a long list at reading speed, pauses at the top and bottom, loops, and reports once when it has reached the bottom; `RotationRunner` moves a scrolling entry on at that signal and a list that fits, or a non-scrolling screen, after the entry's `seconds`. `TimeoutGate` replaces a group's picture with a full-screen "Time-out" countdown while its field group's `timeout_deadline` is in the future. `AudienceSounds` plays tones generated with Web Audio (no audio files) for an audience group with sounds on, and shows a small "Click to enable sound" note until someone clicks once when the browser blocks autoplay. A screen that fails to load shows its title and "Waiting for data" and keeps retrying; a display never goes blank. The pure match-order and clock rules both apps use (a field group's next match, the earliest match not fully scored, the countdown colour bands, `formatClock`) live in `packages/shared/src/display/`, together with the screen-key list and the read types.

**Backups** (`src/routes/BackupsRoute.tsx`, admin nav "Backups"): folder (Change / Use default), last backup and last error, Back up now, and the backups table with Restore. Restore reads `boot_id` from `GET /api/time-sync`, posts the restore, then waits with `useRestartPoll(..., "restarted")`, which polls time sync until a different `boot_id` answers (the picker-route check can't tell a normal-to-normal restart apart). While the restart poll is waiting, Restore, Back up now, Change and Use default are disabled; a `restore_error` from `GET /api/backups` (a startup swap that failed or was cancelled) shows as an `alert alert-danger`, and the status line falls back to the newest listed backup's time when the server has made none since it started. The picker page shows a damaged file's backups when `GET /api/picker/damaged` answers, and a timed-out alert if its restart poll gives up.

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

A spec that adds many teams to the shared event (checked-in teams can't
be deleted) must sort after `team*.spec.ts` — the team-grid specs assume
a small roster and break once their new row is virtualized out of view.
That is why the schedule spec is named `z_sessionSchedule.spec.ts` (it also
deletes any extra divisions earlier specs left, to start single-division).

A scenario the shared event can't host (its game plugin can't change once
chosen) starts its own backend and Vite server with
`tests/e2e/fixtures/isolatedServer.ts`, as `cooperativeRankings.spec.ts`
does on ports 8125/5185, `finalizeQualification.spec.ts` on 8127/5187, and
`skillsChallenges.spec.ts` (the shipped sample game, with skills on) on
8128/5188, `awards.spec.ts` on 8129/5189, and `gamePluginGating.spec.ts` on 8130/5190, `backups.spec.ts` on 8131/5191, and `devicePairing.spec.ts` on 8132/5192 with the device app's dev server on 5193 (pass `devicePort` to `startIsolatedServer` and it also starts `apps/device` and points the admin dev server's `/device/` and `/pair` proxy at it). `displays.spec.ts` (display groups: Match Control, the Displays page and the device app's display mode) uses 8133/5194 with the device app on 5195. `zz_seasonRankings.spec.ts` runs last for the same
reason as `z_sessionSchedule.spec.ts`.

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
