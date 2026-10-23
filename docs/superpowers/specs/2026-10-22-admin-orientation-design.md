# Admin orientation: sessions-first navigation, readiness and merged devices

Status: draft for review, 2026-10-22.

## Why

An organizer setting up a basic event had to click around too much and could not tell where to go next. A walkthrough on 2026-10-21 counted 31 clicks, 18 page changes and 4 detours to reach the first match. The review notes are in `.impeccable/critique/`, which is not committed.

The root causes:
- The left menu is a flat list of 12 items in no working order.
- Everything used on event day sits three levels down (Sessions → session → tab).
- The Dashboard shows only the event name.
- The only "what's missing" checklist is on the Schedule tab.
- Pairing a TV and choosing what it shows are on two unconnected pages.

The owner usually heads straight to the session on event morning. There they want to see check-in, see inspection status, and plan matches. This design reorganizes the admin around that.

## Goals

1. The admin opens where the organizer is going:
   - a brand-new event opens on a short setup checklist;
   - after that, it opens on today's session.
2. Every screen tells you the next step and links straight to it.
3. Sessions are reachable in one click from the menu, and so are the active session's Match Control and Skills Control.
4. Changing which session is **active**, which drives the TVs, displays, Match Control and Skills Control, only ever happens on purpose. The admin offers the change at a sensible time and never makes it on its own.
5. Pairing a device and choosing what a TV shows happen on one page, in one step. You can make any TV identify itself.
6. Repetitive entry keeps the cursor where you are typing.

## Non-goals (later slices)

- Finals / alliance selection UI. The "Finals can now be generated" copy is a known dead end, tracked separately.
- Meet-day speed work:
  - Match Control keyboard shortcuts;
  - an up-next list;
  - a Back link that returns to where you came from;
  - a warning when submitting while the clock runs.
- TV readability: a countdown and timer sized to the screen, and fixing overlapping elements.
- In-match cues: plugin-defined cue moments such as a driver-change window, sounds, screen flashes.
- The inspections subsystem. This design only reserves a place for it.
- Power-user tools: Ctrl-K, pasting teams from a spreadsheet, event templates.
- A first-run wizard. The owner chose a checklist instead.
- Any change to the rule that teams must be checked in before a schedule can be generated. The owner chose to keep it.

## Anti-goals (would make this a failure even if it works)

- Anything that changes the active session without a person confirming it. A switch in the middle of a match would pull the TVs away.
- The TVs or Match Control following whichever session the admin happens to be *looking at*.
- Adding clicks to anything the organizer does repeatedly on event day.
- Breaking existing links and bookmarks. Old URLs must keep working, redirecting where a page moved.

## Constraints

- Admin SPA stack and conventions as in `frontend/CLAUDE.md`.
- Every new string in English and Chinese.
- Visual direction unchanged: the "meet-day operations desk", with a paper ground, ink text, one amber accent for primary actions and live state, and dense and legible layouts.
- Testing policy from the root `CLAUDE.md`:
  - Vitest for logic and components;
  - Playwright for the golden path and edge cases;
  - pytest for any server change.
- Never name a real-world competition brand or product anywhere in the repo.
- Front desk and judge roles keep their current menus. This design changes the admin role only.

## The design

### 1. Header

- **Left:** the event name.
- **Right:**
  - the active session as an amber pill with a live dot, linking to that session's Today tab. It reads "No active session" when there is none;
  - the current time;
  - the theme toggle;
  - Log out.
- "Switch tournament" moves out of the header into the Settings group of the menu.

### 2. Left menu (admin role)

Three groups:

```
EVENT
  Event & game            ← was "Event & plugins"; also holds the event name (was on the Dashboard)
  Teams & divisions       ← Teams page, with Divisions as a second tab on it
  Devices & displays      ← merged page, section 6
  Season rankings
SESSIONS
  ● Saturday Qualifier    ← active session marked with the live dot
      Match Control       ← shown only under the active session
      Skills Control      ← only under the active session, and only when skills are on
  Sunday Qualifier
  Finals Day
  + New session
SETTINGS
  Role passwords
  Backups
  Switch tournament
```

- Sessions are listed by date, then creation order. A session without a date goes last.
- Clicking a session opens it on its Today tab.
- Match Control and Skills Control keep their current URLs (`/match-control`, `/skills-control`) and keep following the active session. Only their place in the menu changes.
- With no active session, neither item is listed. The Today tab and the header pill say how to make one active.
- On narrow screens the menu collapses to the existing horizontal strip.

### 3. What opens when you log in (`/`)

1. **The event isn't set up yet** (no game chosen, no teams, or no sessions): show the **event checklist** page:
   1. Choose the game.
   2. Add teams, typed in or uploaded from a spreadsheet.
   3. Create the first session.

   Each row shows ✓ or ✗ with a link to where you do it. Done rows stay visible and ticked.
2. **Otherwise**, open a session's Today tab, chosen in this order:
   1. the session whose date is today, in that session's timezone;
   2. the active session;
   3. the next session by date;
   4. the most recent.
3. If game or teams later go missing while sessions exist, those event-level items show at the top of the Today tab, with links.

**Viewing vs. active.** The session you are looking at and the active session are separate. Clicking any session in the menu only changes your view. The TVs, displays, Match Control and Skills Control follow the active session only.

### 4. Session pages

Tabs, in order:
- **Today**
- **Setup**
- **Check-In**
- **Schedule**
- **Matches**
- **Skills**, when skills are on
- **Rankings**
- **Awards**

`/sessions/:id` opens on **Today**. Today it always opens on Check-In.

The session header keeps the label and date. "Set as active session" becomes a button shown only when the session isn't active.

**Today tab**, three cards:
- **Check-in.** "18 / 24 checked in" with a progress bar, and a primary button that goes to the Check-In tab.
- **Inspection.** A reserved card that says inspection status will appear here once inspections exist. It does no work in this slice.
- **Matches.** The readiness checklist, extended from `schedule/readiness.ts` with ✓/✗ rows and a deep link each:
  1. Timezone set.
  2. Fields.
  3. Playing times.
  4. Teams checked in.
  5. Schedule generated.
  6. Session is active.

  In an event with several divisions, each row is green only when every division is ready, and its link goes to the Schedule tab, which already has division tabs. "Schedule generated" means every division has a schedule.
  7. At least one TV shows something for this session. This row is informational; it doesn't block anything.

  The card's single primary button is the next step:
  - "Set up the session" while Setup items are missing;
  - "Plan matches" (to Schedule) until a schedule exists;
  - "Make active" if it isn't active;
  - "Go to Match Control" when everything is green.

**Setup tab** gathers the session's own settings:
- label, date, timezone, and the live-score switches, which today live only in the inline Edit row on the Sessions list;
- the existing Fields page content (field sets and fields).

`/sessions/:id/fields` redirects to `/sessions/:id/setup`. Playing times and rounds stay on the Schedule tab, beside the fit check that depends on them. That is my call; see "Calls I made".

**Timezone.**
- A new session's timezone defaults to the browser's timezone.
- The "(optional)" label goes away.
- The readiness "Set the timezone" link goes to the Setup tab's timezone field, not to the Sessions list.

**Playing times.** The prefilled playing-time row uses the session's date, not today's date. It is clearly marked as unsaved until it is saved.

**Creating a session** ("+ New session" in the menu) asks for a label and date, defaulting to the browser's timezone, then opens the new session's Setup tab. The old Sessions list page (`/sessions`) stays reachable from a "Manage sessions" link next to "+ New session", for renaming, deleting, and seeing everything at once.

### 5. The "make it active" banner

The admin offers to change the active session; it never changes it by itself.

**When it shows:**
- Let A be the active session and B the next session after it.
- Each session's span runs from the start of its first playing time to the end of its last.
- The **cutover point** is halfway between the end of A's span and the start of B's span.
- From the cutover point until the end of B's span, every admin page shows a banner across the top: "**B** is scheduled to start at 13:00. Make it the active session? The TVs and Match Control will switch to it." It has two buttons, **Make it active** and **Not yet**.
- Before the cutover point, nothing shows. A can run over without the organizer being nagged.

**Edge cases:**
- **Different days:** the cutover point falls overnight.
- **No active session:** if now falls inside any session's span, offer that session.
- **No playing times:** a session without playing times counts as spanning its whole date in its timezone. A session with no date is never offered.
- **Not yet** hides the banner for that session in this browser for 15 minutes.
- **A match is running** on the active session: "Make it active" first asks for confirmation, naming the match that is running.
- **Session B has no TV spots yet:** "Make it active" first offers "Copy TV spots from A". This uses the existing copy-displays feature. The two choices are **Copy and make active** and **Make active without copying**. The second leaves the TVs blank until someone sets their spots. This applies wherever a session is made active: the banner, the Today tab and the session header. (Owner's decision.)

### 6. Devices & displays (one page, `/devices`)

`/displays` redirects here. Top to bottom:

1. **Pair a device.** The pairing instructions sit here, with the server address moved from "Event & plugins". The fields are:
   - the code shown on the device;
   - the kind of device: TV / display first and the default, then scorer, referee, front desk and so on;
   - a name;
   - for a TV, **Shows:** a picker of the spots in the selected session:
     - each field set's audience screen;
     - each field;
     - each pit group;
     - "Nothing yet".

   **Pair** pairs the device and gives a TV its spot in one step.
2. **"Spots for: [session ▾]"** sits at the top right. It defaults to the active session and changes only this page's view.
3. **TVs and displays table.** One row per paired display device, with:
   - its name;
   - what it shows in the selected session, as a dropdown that changes it in place;
   - its connection: "● Connected" or "● Not connected · last seen 4 min ago";
   - an **Identify** button;
   - the existing rename and remove actions.

   Below the table is "Copy spots from another session", the existing copy feature.
4. **Scorers, referees and other devices** table: name, role, status, and the existing actions. The idle-timeout setting stays on this page.

A warning shows on this page when there is no active session: "TVs show nothing until a session is active", with a link to fix it.

**Connection vs. status.** "Connected" means the device has a live connection right now. The server already tracks this (`realtime.by_device`, which `/api/displays` reports as `online`). It is shown *alongside* the existing active / idle / disabled status and its Enable/Disable actions, in both tables; it doesn't replace them.

`last_seen_at` is not refreshed by a socket connection. That stays as it is, because a scorer's idle timeout depends on it.

**Identify** already exists and moves here unchanged:
- the endpoint is `POST /api/displays/{device_id}/identify`;
- the device shows its name full-screen for 10 seconds;
- today the button sits in `displays/DisplayRows.tsx`.

The only new behavior: if the device is offline, the button says so instead of failing silently. Identify stays TVs-only.

**Spots section.** Everything else `/displays` does today moves onto this page, in a "Spots" section below the TVs table, under the same session picker:
- each audience group's screen, settings, rotation and sounds;
- pit groups (create, rename, delete, division);
- the "unplaced" warnings.

The "Shows" picker offers whatever spots exist. Nothing that works today is dropped.

### 7. Next-step prompts

After each step that has an obvious next one, show a one-line prompt with a link, in the style of the existing "35 matches scheduled · View matches":

| After you… | The prompt says |
|---|---|
| choose the game | Next: add teams |
| save teams | Next: create a session (or "go to [today's session]" if one exists) |
| create a session | you land on its Setup tab, so no prompt is needed |
| add the first field | Next: playing times and rounds (Schedule) |
| generate a schedule | View matches · Next: make this session active, if it isn't |
| pair a TV without choosing what it shows | Choose what it shows |

Empty states link to their fix:
- "No displays here" links to the pair form.
- Match Control's existing empty state keeps its link.

### 8. Keeping the cursor where you type

- **Adding a field or a field set:** after Enter or Add, the name box clears and keeps focus, so "Field 1 ⏎ Field 2 ⏎ Field 3 ⏎" works without the mouse.
- **Teams, "Add row":** focus moves into the new row's first cell.
- **Adding a division:** same as fields.

## Testing

- **Vitest:**
  - which session `/` opens, for every branch in section 3;
  - the cutover-point and banner rules, with a fixed clock, including:
    - overnight;
    - no playing times;
    - no active session;
    - "Not yet" snoozing;
    - the running-match confirmation;
  - the extended readiness rules and the Today card's primary button;
  - menu contents for active and inactive sessions, with skills on and off;
  - the pair-and-assign form;
  - the focus behavior.
- **Playwright golden path:**
  1. A new event shows the checklist.
  2. Choose the game, then add teams.
  3. "+ New session" lands on Setup, with the timezone prefilled.
  4. Add three fields by keyboard only.
  5. Schedule, then the Today tab steps to "Make active".
  6. Pair a TV with its spot in one step.
  7. Identify shows the name on the device page.
  8. Old URLs (`/displays`, `/sessions/:id/fields`, `/sessions/:id`) land in the right places.
- **Playwright banner:** with the browser clock set past the cutover point, the banner appears. "Make it active", taking the offered copy of TV spots, moves a paired TV to the new session and the same spot.
- **pytest:** only for server changes the build turns out to need. Identify and the connection state already exist and are already tested.

## Left to the builder

- Component structure, and whether the session list in the menu shares a query with other pages.
- Whether pairing plus assigning is one new endpoint or two existing calls in sequence.
- Exact wording beyond what is quoted here, in English and Chinese.
- How the Divisions tab sits inside Teams.

## Calls I made (owner to confirm while reading)

- **Placement:**
  - Playing times and rounds stay on Schedule, not Setup, because the fit check sits next to them.
  - "Event & plugins" is renamed "Event & game", and the event name moves onto it from the old Dashboard.
  - Match Control and Skills Control show only under the active session.
- **Defaults and timings:**
  - The pair form defaults to TV / display. Today it defaults to Scorer.
  - "Not yet" snoozes the banner for 15 minutes in that browser.
  - "Connected" uses the server's live-connection tracking and is shown next to the existing status.
- **Behavior:**
  - The display-spot settings and pit groups move into a "Spots" section on the merged page.
  - With several divisions, readiness rows are green only when every division is ready.
  - Picking which session opens: playing-time dates count as well as the session date. If two sessions fall on today, prefer the active one, then the one running now.
  - "A match is running" means any active-session match that has started and not ended. Skills timers don't count.
  - "Make it active" asks first if a match is running.
  - Picking a session to view in the menu is not remembered across reloads. `/` always applies the rules in section 3.
