# Admin Orientation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the admin app around sessions so an organizer always lands where they're going and is always told the next step.

That means:
- a sessions-first menu;
- a header that shows the active session;
- the landing rules and an event checklist;
- Today and Setup session tabs;
- a "make it active" banner with spot copying;
- a merged Devices & displays page;
- next-step prompts;
- keyboard focus that stays put.

**Architecture:** This is frontend-only work in `frontend/apps/admin`. The server already has every endpoint needed, including identify, `online`, copy-displays and active-session.

New pure logic lives in `src/orientation/`:
- session time spans, the landing choice and the cutover rule;
- session readiness;
- the banner snooze.

That logic is unit-tested with a fixed clock. Thin React components consume it. Existing route components are reused inside new layouts rather than rewritten. Old URLs redirect.

**Tech Stack:** React 18, React Router data routers, TanStack Query, react-i18next, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-admin-orientation-design.md`

## Global Constraints

- Admin role only. The front_desk menu (`/checkin`) and the judge menu (`/judge/awards`, `/judge/rankings`, `/rankings`) are unchanged, and `AppShell.test.tsx`'s role assertions must still pass.
- Every new user-facing string goes in both `src/i18n/en/admin.json` and `src/i18n/zh/admin.json`. Follow the key conventions: nested by screen, buttons ending `Action`, `{{name}}` interpolation.
- Never name a real-world competition brand or product anywhere: code, comments, copy, tests, commit messages.
- Old URLs keep working:
  - `/displays` → `/devices`;
  - `/divisions` → `/teams/divisions`;
  - `/sessions/:id` → `/sessions/:id/today`;
  - `/sessions/:id/fields` → `/sessions/:id/setup`.
- Nothing changes the active session without a person confirming. The TVs follow only `event.active_session_id`, never the session being viewed.
- Visual system unchanged. Use the existing classes (`.panel`, `.alert-*`, `.badge-*`, `.btn-primary` for the single primary action, `.app-nav`, `.app-nav--sub`); amber marks primary actions and live state only.
- Fixed values from the spec:
  - the banner snooze is **15 minutes**, per browser, per session;
  - the pair form's default role is **`display_device`**;
  - Identify on an offline device shows a message instead of calling the API.
- Testing:
  - Vitest for every new module and changed route;
  - Playwright for the golden path, the banner and the redirects;
  - pytest only if a server change turns out to be needed (none is planned).
- Commit messages are plain sentences ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `admin-orientation`. Don't push.

## Review Focus

1. **A session with no date and no playing times:** it must never be offered by the banner or chosen as "today". It is listed last in the menu and still opens normally.
2. **Two sessions on the same date:** the landing picks the active one, then the one whose span contains now. The banner must not offer the session that is already active.
3. **The active session is deleted while the admin is open:** the header pill falls back to "No active session", the menu drops Match Control and Skills Control, and nothing crashes. The `active_session_changed` event with `null` must be handled in the shell.
4. **"Make it active" when neither session has TV spots:** no copy offer appears, because there is nothing to copy. The plain confirm path is used.
5. **localStorage throws** (private mode or blocked storage): the banner still renders and "Not yet" hides it for the current page life. All storage access is wrapped in try/catch.

Each of these has a pinned test in the task that owns the code (Tasks 1, 3 and 4).

---

## File map

| File | Responsibility |
|---|---|
| `src/orientation/sessionTime.ts` (new) | Pure: `sessionSpan`, `orderSessions`, `isSessionToday`, `pickLandingSession`, `cutoverOffer` |
| `src/orientation/readiness.ts` (new) | Pure: `checkEventSetup`, `checkSessionReadiness`, `nextSessionStep` |
| `src/orientation/snooze.ts` (new) | `snoozeBanner`, `isBannerSnoozed` (localStorage, 15 min) |
| `src/orientation/useOrientationData.ts` (new) | Hooks: `useEvent`, `useSessions`, `useSessionSpans` |
| `src/orientation/useActiveSessionLiveUpdates.ts` (new) | Shell-level `active_session_changed` subscription |
| `src/orientation/MakeActiveDialog.tsx` (new) | Confirm, running-match warning, copy-spots offer, then activate |
| `src/orientation/ActiveSessionBanner.tsx` (new) | The cutover banner |
| `src/orientation/NextStep.tsx` (new) | One-line "Next: …" prompt with a link |
| `src/components/AppShell.tsx` | New header, grouped admin menu, banner mount |
| `src/components/SessionNavList.tsx` (new) | The Sessions group of the menu |
| `src/routes/HomeRoute.tsx` (new, replaces `DashboardRoute.tsx`) | Event checklist or redirect to the landing session |
| `src/routes/SessionTodayRoute.tsx` (new) | The Today tab |
| `src/routes/SessionSetupRoute.tsx` (new) | The Setup tab: settings form plus the existing fields content |
| `src/routes/SessionNewRoute.tsx` (new) | The "+ New session" page |
| `src/routes/TeamsLayout.tsx` (new) | Teams / Divisions tabs |
| `src/routes/DevicesDisplaysRoute.tsx` (new, replaces `DevicesRoute.tsx` and `DisplaysRoute.tsx`) | The merged page |
| `src/routes/SessionDetailLayout.tsx` | Tabs, header activate button via `MakeActiveDialog` |
| `src/routes/EventSetupRoute.tsx` | Gains the event-name editor; loses `ServerInfoPanel` (moved) |
| `src/devices/PairDeviceForm.tsx` | Default role `display_device`; "Shows" picker; pair + assign |
| `src/router.tsx` | New routes and redirects |

---

### Task 1: Session time rules

**Files:**
- Create: `src/orientation/sessionTime.ts`
- Test: `tests/unit/sessionTime.test.ts`

**Interfaces:**
- Consumes: `SessionRead`, `PlayingWindowRead` from `src/types.ts`.
- Produces:
```ts
export interface SessionSpan { start: Date; end: Date }
export function sessionSpan(session: SessionRead, windows: PlayingWindowRead[], fallbackZone: string): SessionSpan | null;
export function orderSessions(sessions: SessionRead[]): SessionRead[];
export function isSessionToday(session: SessionRead, windows: PlayingWindowRead[], now: Date, fallbackZone: string): boolean;
export function pickLandingSession(input: {
  sessions: SessionRead[]; windowsById: Record<number, PlayingWindowRead[]>; activeId: number | null; now: Date; fallbackZone: string;
}): number | null;
export interface CutoverOffer { sessionId: number; startsAt: Date }
export function cutoverOffer(input: {
  sessions: SessionRead[]; windowsById: Record<number, PlayingWindowRead[]>; activeId: number | null; now: Date; fallbackZone: string;
}): CutoverOffer | null;
```

**Rules** (`fallbackZone` is the browser zone, used when `session.timezone` is null):
- **`sessionSpan`:**
  - With windows: start is the earliest `start_utc`, end is the latest `end_utc`. Skip windows whose UTC fields are null.
  - Else with `session_date`: the whole day, 00:00 to 24:00, in the session's zone.
  - Else `null`.
- **`orderSessions`:** by `session_date` ascending, then `id`. A null date goes last.
- **`isSessionToday`:** now's calendar date in the session's zone equals `session_date` or any window's `date`. Use `Intl.DateTimeFormat("en-CA", {timeZone})` to get `YYYY-MM-DD`.
- **`pickLandingSession`:**
  1. Among today's sessions: the active one, else the one whose span contains `now`, else the first in `orderSessions` order.
  2. If none is today: the active one.
  3. Else the session with the smallest span start ≥ now.
  4. Else the session with the latest span end.
  5. Else the first in `orderSessions`.
  6. Return `null` only for an empty list.
- **`cutoverOffer`:**
  - If the active session exists and has a span A, let B be the non-active session with the earliest span start ≥ A.end.
    - The cutover is `A.end + (B.start − A.end) / 2`.
    - Return `{sessionId: B.id, startsAt: B.start}` when `cutover ≤ now < B.end`, else `null`.
  - If there is no active session, or the active one has no span: offer the non-active session whose span contains `now`, with `startsAt` set to its span start, else `null`.
  - Never offer the active session.

- [ ] **Step 1: Write the failing tests.** Use sessions in `America/Los_Angeles` with `start_utc`/`end_utc` set. Add `describe` blocks with these exact cases:
  - `sessionSpan`:
    - uses the earliest and latest window UTC;
    - is the whole day when there are no windows, so for date `2026-11-07` in LA, start = `2026-11-07T08:00:00Z`;
    - returns null with no date and no windows.
  - `orderSessions`: puts null dates last and breaks ties by id.
  - `pickLandingSession`:
    - prefers today's active session over another session today;
    - prefers the session whose span contains now when the active one isn't today;
    - falls back to active, then the next upcoming, then the most recent;
    - never picks a dateless, windowless session over a dated one;
    - returns null for `[]`.
  - `cutoverOffer`:
    - A has 09:00–12:00 and B has 13:00–17:00 on the same day. Expect `null` at 12:29, an offer of B at 12:30, and `null` at 17:00.
    - With A on Saturday and B on Sunday, the cutover falls overnight.
    - With no active session, it offers the session running now.
    - It never offers the active session.
    - A dateless session is never offered (Review Focus 1).
    - Two sessions on the same date (Review Focus 2) give the expected landing and offer.
- [ ] **Step 2:** Run `cd frontend/apps/admin && npx vitest run tests/unit/sessionTime.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3:** Implement `src/orientation/sessionTime.ts` per the rules above. Pure functions, no React.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit: "Add the session time rules for choosing today's session and offering the next active session, with tests."

### Task 2: Readiness for the event and a session

**Files:**
- Create: `src/orientation/readiness.ts`
- Test: `tests/unit/orientationReadiness.test.ts`

**Interfaces:**
- Consumes: `countUsableFields` and `countCheckedInTeams` from `src/schedule/readiness.ts` (unchanged); `Division`, `TeamSummary`, `ParticipationRead`, `FieldSetRead`, `FieldRead`, `MatchRead`, `SessionRead`, `MatchFormat`.
- Produces:
```ts
export type EventSetupKey = "gamePlugin" | "teams" | "session";
export function checkEventSetup(input: { gamePluginSelected: boolean; teamCount: number; sessionCount: number }): { key: EventSetupKey; ok: boolean }[];
export type SessionReadinessKey = "timezone" | "fields" | "playingTimes" | "teams" | "schedule" | "active" | "displays";
export interface SessionReadinessItem { key: SessionReadinessKey; ok: boolean; blocking: boolean }
export function checkSessionReadiness(input: {
  session: SessionRead; activeSessionId: number | null; divisions: { id: number }[]; teams: TeamSummary[];
  participants: ParticipationRead[]; fieldSets: FieldSetRead[]; fields: FieldRead[]; windowCount: number;
  matches: MatchRead[]; matchFormat: MatchFormat | null; displayCount: number;
}): SessionReadinessItem[];
export type NextSessionStep = "setup" | "planMatches" | "makeActive" | "matchControl";
export function nextSessionStep(items: SessionReadinessItem[]): NextSessionStep;
```

**Rules:**
- The items come back in this order: timezone, fields, playingTimes, teams, schedule, active, displays.
- With more than one division, `fields`, `teams` and `schedule` are ok only when **every** division passes.
  - `fields` uses `countUsableFields(fieldSets, fields, divisionId)`.
  - `teams` uses `countCheckedInTeams(…) ≥ teams_per_alliance × alliance_count`.
  - `schedule` means at least one non-finals match with that `division_id`.
- With one division, use `divisionId = null` as `SessionScheduleRoute` does today.
- `displays.ok = displayCount > 0`. It is the only item with `blocking: false`.
- `nextSessionStep`:
  - `"setup"` if timezone or fields fail;
  - else `"planMatches"` if playingTimes, teams or schedule fail;
  - else `"makeActive"` if active fails;
  - else `"matchControl"`.

- [ ] **Step 1: Write failing tests:**
  - `checkEventSetup`: all three are false on an empty event and all true when filled.
  - `checkSessionReadiness`:
    - the item order;
    - a multi-division event where division 2 has no fields: `fields.ok === false`;
    - `schedule` is false until each division has a non-finals match;
    - `displays` is never blocking.
  - `nextSessionStep` returns each of its four results from the matching inputs.
- [ ] **Step 2:** Run `npx vitest run tests/unit/orientationReadiness.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement `src/orientation/readiness.ts`.
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: "Add event setup and per-session readiness checks covering every division, with the next-step rule."

### Task 3: Shared data hooks, snooze, live updates, and the make-active dialog

**Files:**
- Create:
  - `src/orientation/useOrientationData.ts`
  - `src/orientation/snooze.ts`
  - `src/orientation/useActiveSessionLiveUpdates.ts`
  - `src/orientation/MakeActiveDialog.tsx`
- Modify: `src/i18n/en/admin.json`, `src/i18n/zh/admin.json` (new `orientation.*` namespace)
- Test: `tests/unit/snooze.test.ts`, `tests/unit/MakeActiveDialog.test.tsx`

**Interfaces:**
- Produces:
```ts
// useOrientationData.ts — same query keys the app already uses, so caches are shared
export function useEvent(): UseQueryResult<EventRead>;                       // ["event"], GET /api/event
export function useSessions(): UseQueryResult<SessionRead[]>;                // ["sessions"], GET /api/sessions
export function useSessionWindows(sessionIds: number[]): { windowsById: Record<number, PlayingWindowRead[]>; isLoading: boolean }; // useQueries over ["playingWindows", id]
export function browserZone(): string;                                       // Intl.DateTimeFormat().resolvedOptions().timeZone
// snooze.ts
export const BANNER_SNOOZE_MS = 15 * 60 * 1000;
export function snoozeBanner(sessionId: number, now: Date): void;            // localStorage key `orientation.bannerSnooze.${sessionId}`
export function isBannerSnoozed(sessionId: number, now: Date): boolean;
// useActiveSessionLiveUpdates.ts
export function useActiveSessionLiveUpdates(): void; // /ws/active-session; on active_session_changed invalidate ["event"], ["sessions"]
// MakeActiveDialog.tsx
export function MakeActiveDialog(props: { targetSession: SessionRead; onClose: () => void; onActivated?: () => void }): JSX.Element;
export function useMakeActive(): { open: (session: SessionRead) => void; dialog: ReactNode };
```

**MakeActiveDialog behavior.** It is built on the existing `ConfirmDialog` look (`<dialog>`; see `src/components/ConfirmDialog.tsx`).
- **On open it loads:**
  - the current event;
  - the running match on the current active session: `GET /api/matches?session_id=<active>`, typed as `LiveMatch[]` from `@tournament-admin/shared`. Running means `phase` is not `"not_started"` or `"ended"`;
  - `GET /api/displays?session_id=<target>` and `GET /api/displays?session_id=<active>`, via `useDisplays`.
- **The body says:** "Make {{label}} the active session? The TVs, Match Control and Skills Control will switch to it."
  - When a match is running, add a warning paragraph: "{{match}} is running on {{activeLabel}}."
- **The buttons:**
  - **Target `has_setup === false` and source `has_setup === true`:** **Copy TV spots and make active** (`POST /api/sessions/{target}/copy-displays {source_session_id: active}`, then activate), **Make active without copying**, and Cancel.
  - **Otherwise:** **Make active** and Cancel. This covers Review Focus 4.
- **To activate:** `POST /api/event/active-session {session_id}`, then invalidate `["event"]`, `["sessions"]` and `["displays"]`, then `onActivated`.
- **Errors:** an `alert alert-danger` inside the dialog, using `apiErrorMessage`.

**Snooze:** wrap every `localStorage` call in try/catch. On failure, fall back to a module-level `Map` (Review Focus 5).

- [ ] **Step 1: Write failing tests:**
  - `snooze.test.ts`:
    - snoozed right after `snoozeBanner`;
    - not snoozed after 15 minutes;
    - still works when `localStorage.setItem` throws (stub it to throw).
  - `MakeActiveDialog.test.tsx`, with `apiRequest` mocked as in `DisplaysRoute.test.tsx`:
    - a target with no spots and a source with spots offers both copy buttons; choosing copy calls copy-displays then active-session, in that order;
    - with neither session having spots, only "Make active" shows;
    - with a running match (phase `"driver"`), the warning names the match label;
    - Cancel calls neither endpoint.
- [ ] **Step 2:** Run `npx vitest run tests/unit/snooze.test.ts tests/unit/MakeActiveDialog.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement the four files and add the en and zh strings.
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: "Add shared event and session hooks, the banner snooze, a shell-level active-session subscription, and a make-active dialog that warns about a running match and offers to copy TV spots."

### Task 4: Header, sessions-first menu, and the banner

**Files:**
- Create: `src/components/SessionNavList.tsx`, `src/orientation/ActiveSessionBanner.tsx`
- Modify: `src/components/AppShell.tsx`, `src/styles/components.css`, both `admin.json` files
- Test: `tests/unit/AppShell.test.tsx` (update), `tests/unit/ActiveSessionBanner.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 `orderSessions`, `cutoverOffer`; Task 3 `useEvent`, `useSessions`, `useSessionWindows`, `browserZone`, `isBannerSnoozed`, `snoozeBanner`, `useMakeActive`, `useActiveSessionLiveUpdates`; `useSkillsSettings`.
- Produces: `SessionNavList(): JSX.Element` and `ActiveSessionBanner(): JSX.Element | null`.

**Header** (admin only; the other roles keep today's header):
- **Left:** the event name, from `useEvent`.
- **Right:**
  - the active-session pill, a `Link` to `/sessions/{id}/today`. It has class `badge badge-success` plus a dot and reads "Active: {{label}}", or a neutral badge reading "No active session";
  - a clock showing local `HH:MM`, ticking every 30 s;
  - `ThemeToggle`;
  - Log out.
- The "Switch tournament" button leaves the header.

**Admin menu groups**, using `<h2 className="app-nav__group">` headings with the new CSS (small uppercase, muted):
- **Event:**
  - Event & game (`/events/setup`)
  - Teams & divisions (`/teams`)
  - Devices & displays (`/devices`)
  - Season rankings (`/rankings`)
- **Sessions:** `<SessionNavList/>`.
  - One `NavLink` per session in `orderSessions` order, to `/sessions/{id}/today`. Mark it active for any `/sessions/{id}/*` path. The active session gets a live dot and `aria-label` "{{label}} (active)".
  - Directly under the active session, indented: Match Control (`/match-control`), and Skills Control (`/skills-control`) only when `useSkillsSettings().data?.enabled`.
  - Then "+ New session" (`/sessions/new`) and "Manage sessions" (`/sessions`).
- **Settings:**
  - Role passwords
  - Backups
  - Switch tournament: a button styled as a nav link that calls the existing `switchMutation`.

**Banner.** Mount it right after `GamePluginBanner`, admin only.
- It calls `cutoverOffer` with `now` ticking every 30 s. It hides when the result is null or `isBannerSnoozed`.
- Copy: "**{{label}}** is scheduled to start at {{time}}. Make it the active session? The TVs and Match Control will switch to it." `time` is `startsAt`, formatted `HH:MM` in the offered session's zone.
- Buttons:
  - **Make it active** opens `useMakeActive` for that session.
  - **Not yet** calls `snoozeBanner` and hides the banner.
- Uses class `alert alert-warning active-session-banner` with `role="status"`.

Call `useActiveSessionLiveUpdates()` once in `AppShell` for the admin role.

- [ ] **Step 1: Update and write failing tests.** In `AppShell.test.tsx`, mock `apiRequest` for `/api/event`, `/api/sessions`, `/api/sessions/{id}/playing-windows` and `/api/skills/settings`. Assert:
  - the three group headings;
  - the sessions in date order, with a null date last;
  - Match Control appears only under the active session;
  - Skills Control appears only with skills enabled;
  - with no active session, neither control appears and the pill reads "No active session" (Review Focus 3);
  - the front_desk and judge menus are unchanged (keep the existing assertions).

  In `ActiveSessionBanner.test.tsx`, use `vi.useFakeTimers()` with `vi.setSystemTime`:
  - the banner is hidden before the cutover and shown after it;
  - "Not yet" hides it, and it reappears after 15 minutes;
  - "Make it active" opens the dialog.
- [ ] **Step 2:** Run `npx vitest run tests/unit/AppShell.test.tsx tests/unit/ActiveSessionBanner.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement the header, the menu, the banner and the CSS (`.app-nav__group`, `.app-nav__sub-link`, `.app-header__session`, `.active-session-banner`) using the existing tokens.
- [ ] **Step 4:** Run it again, then `npx vitest run`. Expect PASS; fix any other test that relied on the old nav labels.
- [ ] **Step 5:** Commit: "Rebuild the admin shell around sessions: event name and active-session pill in the header, Event, Sessions and Settings menu groups with Match and Skills Control under the active session, and the make-it-active banner."

### Task 5: Routes, landing, and the event checklist

**Files:**
- Create: `src/routes/HomeRoute.tsx`, `src/routes/SessionNewRoute.tsx`, `src/routes/TeamsLayout.tsx`
- Delete: `src/routes/DashboardRoute.tsx`, `tests/unit/DashboardRoute.test.tsx`
- Modify:
  - `src/router.tsx`;
  - `src/routes/EventSetupRoute.tsx`, which gains an "Event name" panel at the top, moved verbatim from the Dashboard (same `InlineEditableText` props, labels and `PATCH /api/event`);
  - `src/routes/SessionsRoute.tsx`, where the create form's timezone defaults to `browserZone()` and the label "(optional)" is removed from `sessions.timezoneLabel` in en and zh;
  - both `admin.json` files.
- Test: `tests/unit/HomeRoute.test.tsx`, `tests/unit/SessionNewRoute.test.tsx`, `tests/unit/routerRedirects.test.tsx`, plus updates to `EventSetupRoute.test.tsx` and `SessionsRoute.test.tsx`

**Interfaces:**
- Consumes: Task 1 `pickLandingSession`; Task 2 `checkEventSetup`; Task 3 hooks.
- Produces these routes:

| Path | Element |
|---|---|
| `/` | `HomeRoute`, with `indexLoader` still first for the other roles |
| `/sessions/new` | `SessionNewRoute` |
| `/teams` | `TeamsLayout`, wrapping index `TeamsRoute` and `divisions` → `DivisionsRoute` |
| `/divisions` | redirect to `/teams/divisions` |
| `/displays` | redirect to `/devices` |
| `/sessions/:id` (index) | redirect to `/sessions/:id/today` |
| `/sessions/:id/fields` | redirect to `/sessions/:id/setup` |

  The `today` and `setup` children are added by Tasks 6 and 7. Until then, register them with placeholder elements so the redirects resolve.

**`HomeRoute`:**
- If `checkEventSetup` has any failing item, render `<h1>` "Get your event ready" and an ordered list of the three items.
  - Each item shows ✓ or ✗ and a link:
    - choose the game → `/events/setup#game-plugins`;
    - add teams → `/teams`;
    - create the first session → `/sessions/new`.
  - Done items stay, ticked.
- Otherwise `<Navigate replace to={`/sessions/${pickLandingSession(...)}/today`} />`.
- While loading, show `sessions.loading`.

**`SessionNewRoute`** is a form with:
- label (autoFocus);
- date;
- timezone, a select defaulting to `browserZone()` and built from `Intl.supportedValuesOf` as in SessionsRoute.

Submit sends `POST /api/sessions`, invalidates `["sessions"]`, and navigates to `/sessions/{new.id}/setup`.

**`TeamsLayout`:** `<h1>` "Teams & divisions", an `app-nav app-nav--sub` with Teams and Divisions tabs, and `<Outlet/>`.

- [ ] **Step 1: Write failing tests:**
  - `HomeRoute`: an empty event shows the checklist with three ✗ rows and the correct hrefs; a set-up event navigates to the session `pickLandingSession` picks (assert via a `MemoryRouter` catch-all route).
  - `SessionNewRoute`: the timezone defaults to the stubbed `Intl.DateTimeFormat().resolvedOptions().timeZone`, and submitting navigates to `/sessions/7/setup`.
  - `routerRedirects`: each redirect in the table above lands on its target.
  - `EventSetupRoute`: the event-name edit works there.
- [ ] **Step 2:** Run these test files. Expect FAIL.
- [ ] **Step 3:** Implement the code and the en/zh strings, then delete the Dashboard route and its test.
- [ ] **Step 4:** Run `npx vitest run` and `npx tsc --noEmit -p .`. Expect PASS and clean.
- [ ] **Step 5:** Commit: "Open the admin on an event checklist or today's session, add a new-session page that defaults to the browser's timezone, put Teams and Divisions under one page, move the event name to Event & game, and redirect the old addresses."

### Task 6: The session Today tab and the session header

**Files:**
- Create: `src/routes/SessionTodayRoute.tsx`
- Modify:
  - `src/routes/SessionDetailLayout.tsx`: the new tab order is Today, Setup, Check-In, Schedule, Matches, Skills (when enabled), Rankings, Awards. The Fields tab is removed. The header's "Set as active session" button opens `useMakeActive` instead of calling the API directly.
  - `src/router.tsx`: `today` → `SessionTodayRoute`.
  - `src/styles/components.css` and both `admin.json` files.
- Test: `tests/unit/SessionTodayRoute.test.tsx`, plus an update to `SessionDetailLayout.test.tsx`

**Interfaces:**
- Consumes: Task 2 `checkEventSetup`, `checkSessionReadiness`, `nextSessionStep`; Task 3 `useMakeActive`, `useEvent`; `useSessionMatches`, `useDisplays`; the existing participants, teams, divisions, fieldSets, fields, playingWindows and matchFormat queries (same keys).

**Layout:**
- At the top, any failing `checkEventSetup` items render as an `alert alert-warning` with links (spec §3.3).
- Then three `.panel` cards in a `.session-today` grid:
  - **Check-in:**
    - "{{checked}} / {{total}} checked in", where total is the number of teams in the event;
    - a `<progress>`;
    - a `btn btn-primary` "Check teams in" linking to `/sessions/{id}/checkin`.
  - **Inspection:** "Inspection status will appear here once inspections are available." No actions.
  - **Matches:** the seven readiness rows, each ✓/✗ with a link:
    - timezone → `/sessions/{id}/setup#session-timezone`;
    - fields → `/sessions/{id}/setup#fields`;
    - playingTimes → `/sessions/{id}/schedule#playing-times`;
    - teams → `/sessions/{id}/checkin`;
    - schedule → `/sessions/{id}/schedule`;
    - active opens `useMakeActive`;
    - displays → `/devices`.

    Then one button for `nextSessionStep`:

    | Step | Label | Action |
    |---|---|---|
    | `setup` | "Set up the session" | to the Setup tab |
    | `planMatches` | "Plan matches" | to the Schedule tab |
    | `makeActive` | "Make active" | opens the dialog |
    | `matchControl` | "Go to Match Control" | to `/match-control` |

    Only this button is `btn-primary` on the Matches card. The Check-in card's button stays primary only while `teams` fails; otherwise it is `btn`.

- [ ] **Step 1: Write failing tests:**
  - a fresh session shows "Set up the session";
  - with everything ready except active, the card shows "Make active", and clicking it opens the dialog;
  - with everything green, it shows a "Go to Match Control" link;
  - the multi-division `fields` row is ✗ when one division lacks fields;
  - the check-in count renders `18 / 24`;
  - the tabs render in the new order with no Fields tab;
  - `/sessions/1` lands on Today.
- [ ] **Step 2:** Run the two test files. Expect FAIL.
- [ ] **Step 3:** Implement the code and strings.
- [ ] **Step 4:** Run `npx vitest run`. Expect PASS.
- [ ] **Step 5:** Commit: "Add the session Today tab with check-in progress, a reserved inspection card and a readiness checklist whose single primary button is the next step, and make the session header's activate button use the make-active dialog."

### Task 7: The session Setup tab

**Files:**
- Create: `src/routes/SessionSetupRoute.tsx`, `src/sessions/SessionSettingsForm.tsx`
- Modify:
  - `src/routes/SessionFieldsRoute.tsx`: export its body as `SessionFieldsPanel` with no `<h1>`, wrapped in `<section id="fields">`;
  - `src/schedule/ReadinessChecklist.tsx`: the `timezone` fix link → `/sessions/{id}/setup#session-timezone`, and `fields` → `/sessions/{id}/setup#fields`;
  - `src/schedule/PlayingTimesPanel.tsx`: an unsaved draft row shows a `badge badge-warning` "Not saved yet" until saved;
  - `src/router.tsx`: `setup` → `SessionSetupRoute`;
  - both `admin.json` files.
- Test: `tests/unit/SessionSetupRoute.test.tsx`, plus updates to `SessionFieldsRoute.test.tsx` and `PlayingTimesPanel` tests if present

**Interfaces:**
- Produces: `SessionSettingsForm(props: { session: SessionRead }): JSX.Element`.
  - Fields: label, date, `#session-timezone` select, and the two live-score checkboxes.
  - When `session.timezone` is null, the select initially shows `browserZone()` with a hint, "Not saved yet: we suggested your computer's timezone."
  - Save sends `PATCH /api/sessions/{id}` with all five fields and invalidates `["sessions"]`.
- `SessionSetupRoute` renders `SessionSettingsForm`, then `SessionFieldsPanel`. When the URL has a hash, it scrolls to and focuses the matching element after the data has loaded.

- [ ] **Step 1: Write failing tests:**
  - the Setup tab shows the session's values;
  - a null timezone shows the suggested browser zone and the hint;
  - Save sends the PATCH body with `timezone`, `live_scores_qualification` and `live_scores_finals`;
  - the fields panel renders under `#fields`;
  - the readiness timezone link points to `/sessions/1/setup#session-timezone`;
  - an unsaved playing-time row shows "Not saved yet".
- [ ] **Step 2:** Run the test files. Expect FAIL.
- [ ] **Step 3:** Implement the code and strings.
- [ ] **Step 4:** Run `npx vitest run`. Expect PASS.
- [ ] **Step 5:** Commit: "Add the session Setup tab with the session's date, timezone and live-score switches above its fields, point the readiness links there, and mark an unsaved playing-time row."

### Task 8: Merged Devices & displays page

**Files:**
- Create: `src/routes/DevicesDisplaysRoute.tsx`
- Delete: `src/routes/DisplaysRoute.tsx`, and fold `src/routes/DevicesRoute.tsx` into the new route (delete it after moving). Move `tests/unit/DisplaysRoute.test.tsx` and `tests/unit/DevicesRoute.test.tsx` into `tests/unit/DevicesDisplaysRoute.test.tsx`.
- Modify:
  - `src/devices/PairDeviceForm.tsx`: default role `display_device`. When the role is `display_device`, add a `#pair-shows` select of the selected session's groups (via `groupOptionLabel`), plus "Nothing yet". On success with a group chosen, call `useDisplayMutations(sessionId).assign` with the new device id from the pair response. New prop `sessionId: number | null`.
  - `src/displays/DisplayRows.tsx`: when `display.online` is false, Identify renders disabled with `title` "This TV isn't connected", and clicking does nothing.
  - `src/routes/EventSetupRoute.tsx`: remove `ServerInfoPanel`. Move it to `src/devices/ServerInfoPanel.tsx`, exported.
  - `src/router.tsx`: `/devices` → `DevicesDisplaysRoute`.
  - both `admin.json` files.
- Test: `tests/unit/DevicesDisplaysRoute.test.tsx`, and update `PairDeviceForm` tests if present

**Interfaces:**
- Consumes: `useDevices`, `useDeviceMutations`, `useDeviceSettings`, `useDisplays`, `useDisplayMutations`, `DisplayRows`, `ScreenSettingsEditor`, `PitGroupEditor`, `ServerInfoPanel`; Task 3 `useEvent`, `useSessions`.

**Page order, top to bottom:**
1. `<h1>` "Devices & displays", with the "Spots for" `#displays-session` select at the right. It is the existing DisplaysRoute session select, defaulting to the active session.
2. When `event.active_session_id` is null, an `alert alert-warning`: "TVs show nothing until a session is active." with a link to the first session's Today tab.
3. `ServerInfoPanel`.
4. `PairDeviceForm sessionId={chosen}`.
5. **TVs and displays.** One table for every `display_device` device, with these columns:
   - Name;
   - Shows, a select bound to `assign`;
   - Connection: `● Connected` / `● Not connected`, from the displays `online` flag;
   - Status: the existing active/idle/disabled badge;
   - Last seen;
   - Actions: Identify, Edit, Enable/Disable, Delete.

   Build the rows by joining `useDevices` (role `display_device`) with `useDisplays(chosen)` by device id. Under the table, "Copy spots from another session" with the existing copy UI, shown whenever another session exists, not only when `!has_setup`.
6. **Spots.** Everything else from DisplaysRoute, unchanged in behavior: audience groups (screen select, `ScreenSettingsEditor`, play sounds), field groups, pits (add pit, `PitGroupEditor`, delete) and the unplaced warning.
7. **Scorers, referees and other devices.** The existing devices table filtered to non-display roles, with the existing actions.
8. The idle-timeout form, unchanged.

The realtime subscriptions from both old routes are kept.

- [ ] **Step 1: Write failing tests.** Port every assertion from the two old test files; nothing gets dropped. Add:
  - the pair form defaults to "TV / display" and shows "Shows";
  - pairing with a group chosen calls `POST /api/devices/pair`, then `PUT /api/displays/assignments` with the returned id;
  - Identify is disabled for an offline TV;
  - the no-active-session warning;
  - the TVs table shows Connection next to Status.
- [ ] **Step 2:** Run `npx vitest run tests/unit/DevicesDisplaysRoute.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement the merged page, then delete the old routes and tests.
- [ ] **Step 4:** Run `npx vitest run` and `npx tsc --noEmit -p .`. Expect PASS and clean.
- [ ] **Step 5:** Commit: "Merge Devices and Displays into one page: pair a TV and choose what it shows in one step, see each TV's connection beside its status, identify only connected TVs, and keep every spot setting under the same session picker."

### Task 9: Next-step prompts and keyboard focus

**Files:**
- Create: `src/orientation/NextStep.tsx`
- Modify:
  - `src/routes/EventSetupRoute.tsx`: after the game is selected, "Next: add teams" → `/teams`.
  - `src/routes/TeamsRoute.tsx`:
    - after a successful save, "Next: create a session" → `/sessions/new`, or "Next: go to {{label}}" → `/sessions/{landing}/today` when sessions exist;
    - `handleAddRow` focuses the new row's number cell via `gridRef.current?.setActivePosition({idx: 0, rowIdx: visibleRows.length}, {shouldFocus: true})` after the state update, using `useEffect` on a pending-focus ref.
  - `src/routes/SessionFieldsRoute.tsx`:
    - the add-field, add-field-set and first-field inputs keep focus after a successful submit, using a ref plus `.focus()` in `onSuccess`;
    - when the first-field form unmounts, focus moves to the new set's add-field input;
    - after the first field is added, "Next: playing times and rounds" → `/sessions/{id}/schedule#playing-times`.
  - `src/schedule/DivisionPlanner.tsx`, or wherever "View matches" renders after Generate: add "Next: make this session active" opening `useMakeActive` when the session isn't active.
  - `src/routes/DivisionsRoute.tsx`: after a create, keep the add form open and refocus `#new-division-name`.
  - `src/routes/DevicesDisplaysRoute.tsx`:
    - after pairing a TV with "Nothing yet", show "Choose what it shows", which focuses that TV's Shows select;
    - an empty TVs table says "No TVs paired yet" with a link that focuses `#pair-code`.
  - both `admin.json` files.
- Test: updates to `EventSetupRoute.test.tsx`, `TeamsRoute.test.tsx`, `SessionFieldsRoute.test.tsx`, `DivisionsRoute.test.tsx`, `DevicesDisplaysRoute.test.tsx`, and the schedule tests

**Interfaces:**
- Produces: `NextStep(props: { to?: string; onClick?: () => void; children: ReactNode }): JSX.Element`. It renders `<p className="next-step">` with the word "Next:" and a link or button.

- [ ] **Step 1: Write failing tests:**
  - typing "Field 1", Enter, "Field 2", Enter, "Field 3", Enter in the field-name box creates three fields with `document.activeElement` still the input (`userEvent.type(input, "Field 1{enter}")`);
  - the same for field sets and divisions;
  - "Add row" puts focus inside the new row's first cell;
  - each prompt appears after its trigger with the right href.
- [ ] **Step 2:** Run the affected test files. Expect FAIL.
- [ ] **Step 3:** Implement the code and strings.
- [ ] **Step 4:** Run `npx vitest run`. Expect PASS.
- [ ] **Step 5:** Commit: "Keep the cursor in the field, field set and division name boxes after each add, focus the new team row, and show a next-step link after choosing the game, saving teams, adding the first field, generating a schedule and pairing a TV."

### Task 10: End-to-end tests and existing-spec updates

**Files:**
- Create: `tests/e2e/orientation.spec.ts`. It uses `startIsolatedServer({backendPort: 8153, frontendPort: 5214, devicePort: 5215})`; check those ports are unused by other specs.
- Modify: every existing spec that navigates by the old menu or URLs. At least:
  - `dashboard.spec.ts` (the event rename moves to `/events/setup`);
  - `displays.spec.ts` and `devicePairing.spec.ts` (`/devices`, default role, merged page);
  - `divisions.spec.ts` and `teamRandomize.spec.ts` (`/teams/divisions`);
  - `sessionCheckin.spec.ts`;
  - `z_sessionSchedule.spec.ts` (Fields → Setup tab, readiness links);
  - `liveScoring.spec.ts`;
  - any spec that clicks a nav label that changed.

  Find them with `grep -rn "getByRole(\"link\"" tests/e2e` and run the full suite.

**orientation.spec.ts, golden path** (`test.describe.serial`):
1. Create the event via the API and log in through the UI. `/` shows "Get your event ready" with three ✗ rows.
2. Upload and select the example game through the UI, then follow "Next: add teams".
3. Add 4 teams. Follow "Next: create a session".
4. Label "Saturday", date `2026-11-07`. The timezone is prefilled (assert non-empty). It lands on `/sessions/{id}/setup`.
5. In the field box, type `Field 1⏎Field 2⏎Field 3⏎` with no clicks between. Expect 3 fields.
6. Save playing times on Schedule, check everyone in, and generate. Today's Matches card then shows "Make active". Click it, confirm, and the header pill reads "Active: Saturday".
7. Open the device app at `/device/`, read its pairing code, and on `/devices` pair it as TV / display with Shows = the audience spot. Its row shows "Connected".
8. Click Identify. The device page shows the device name full-screen.
9. Old URLs `/displays`, `/divisions`, `/sessions/{id}` and `/sessions/{id}/fields` land on `/devices`, `/teams/divisions`, `/sessions/{id}/today` and `/sessions/{id}/setup`.

**Banner** (a second describe):
1. Create a second session "Saturday PM" with windows 13:00–17:00 the same day. The first session's windows are 09:00–12:00 in its timezone.
2. Call `page.clock.setFixedTime` at 12:20 local and reload: no banner.
3. Set the clock to 12:35 and reload: the banner names "Saturday PM".
4. Click "Make it active", choose "Copy TV spots and make active", and confirm.
5. The paired TV's Shows in the "Saturday PM" view has the same spot, and the header reads "Active: Saturday PM".

- [ ] **Step 1:** Write `orientation.spec.ts`. Run `cd frontend/apps/admin && npx playwright test tests/e2e/orientation.spec.ts`. Iterate until it passes.
- [ ] **Step 2:** Run `npx playwright test` (the full suite). Update the broken specs to the new navigation **without weakening their assertions**. Expected: all pass.
- [ ] **Step 3:** Commit: "Test the new admin orientation end to end and update the existing browser tests for the sessions-first menu, the merged Devices & displays page and the moved pages."

### Task 11: Docs

**Files:**
- Modify: `frontend/CLAUDE.md` (admin routes, the `src/orientation/` module, the merged devices page, the redirects), `PRODUCT.md` (admin navigation description), and the spec's status line (`Status: implemented 2026-10-22 on branch admin-orientation`).

- [ ] **Step 1:** Update the three files to describe what now exists. Delete statements about the Dashboard and the separate Displays page.
- [ ] **Step 2:** Run `cd frontend && npm test --workspaces --if-present` and `npx tsc --noEmit -p apps/admin`. Expect everything green.
- [ ] **Step 3:** Commit: "Document the sessions-first admin navigation, the orientation module, the merged Devices & displays page and the old-address redirects."
