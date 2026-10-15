# Display Groups and Screens — Design

**Status:** approved in brainstorming 2026-10-15.

**Builds on:** device pairing (`2026-10-13-device-pairing-design.md`), the realtime design (`2026-09-11-realtime-websockets-design.md`, match control and its live events), skills challenges, finals, and the core architecture spec's §10 gap review ("Display groups and screens").

**Leads to:** skills field displays (with the live-scoring and skills-fields spec), queueing, the score reveal flow ("show to teams", "send to results"), alliance selection, inspection, ceremony slides, sponsor logos, kiosk links and the streaming overlay. Each of those adds its screens and switches to this design; none of them is built here.

## 1. Problem

A paired display shows only "Paired as …". An event needs its TVs to show the right thing without anyone touching them: a big audience screen with the match timer and, between matches, whatever the coordinator picks; a small monitor at every field showing that field's next match and its timer; pit and hallway TVs cycling through rankings and schedules. Nothing in the admin app can start, pause or reset a match either, even though the server supports it.

## 2. How an event uses displays

A single-division event with one field group of 3 teamwork fields and 2 skills fields has about 10 displays:

- **1 audience display** (large TV or projector) facing the spectators. With two divisions there are two, and one group can drive several TVs (for example left and right of the audience).
- **3 teamwork field displays** (around 24"), one per field.
- **2 skills field displays** (later spec; see §11).
- **4 pit displays**, each showing one screen or rotating through several.

One admin runs scoring while another runs the field group from Match Control: queueing, the timer and the audience screen. "Display coordinator" is just an admin; several admins can be signed in at once.

Every display is a kiosk: large type readable across a room, nothing to click, no scrollbars.

## 3. Goals

- Every paired display follows exactly one group per session and needs no touching once set up.
- Field displays always show their own field: the next unscored match, the count-in and timer, then the next match once the score is saved.
- The audience display switches to the match timer by itself when a match starts; between matches an admin picks its screen with one click.
- Pit displays show one screen or a rotation; long lists scroll on the device.
- A league's display setup carries from session to session with one click, and a session at a different venue can have different equipment.
- Adding a screen is one display module, one admin label and one server registry line.

### Non-goals

- Skills field displays and skills timers (live-scoring and skills-fields spec).
- Queueing beyond the next-match override: the phone queue page, the "team is at the field" tick and no-shows (queueing spec).
- The score reveal flow, alliance selection, inspection, ceremony slides and sponsor logos (their own specs, each adding screens here).
- Kiosk links for unpaired browsers and the streaming overlay (chroma-key or transparent background). They come later, together.
- Game-specific controls seen on reference tools (an autonomous-winner picker, field hardware status). Scoring belongs to the game plugin's scoresheet; field hardware isn't modelled.

## 4. Groups

### 4.1 Kinds

A group belongs to a session, as field groups (`FieldSet`) and fields do.

- **Audience group:** one per field group, created with it, deleted with it, named after it. Shows the screen an admin picks; switches to In Match automatically (§6.3).
- **Field group:** one per field, created with it, deleted with it, named after it. Has no screen picker: it always runs the field display (§5.1).
- **Pit group:** created by an admin with a name and a division (null in a single-division event). Shows one screen or a rotation.

A display device follows at most one group per session. Several displays may follow the same group.

### 4.2 The `display_groups` table

| Column | Notes |
|---|---|
| `id` | |
| `session_id` | FK sessions |
| `kind` | `audience`, `field`, `pit` |
| `field_set_id` | audience only (FK field_sets) |
| `field_id` | field only (FK fields) |
| `name` | pit only; audience and field groups take their field group's or field's name |
| `division_id` | pit only, nullable |
| `screen` | screen key, audience and pit; null for field groups |
| `screen_settings` | JSON object, settings for `screen` |
| `rotation` | JSON list of `{screen, settings, seconds}`, pit only; null means show `screen` |
| `play_sounds` | bool, audience only, default false |

- New audience groups start on `logo`; new pit groups start on `teamwork_rankings`.
- `create_app()` creates any missing audience and field groups for existing field groups and fields at startup (idempotent self-heal, like the existing sole-division and role-credential heals), so existing tournament files work.
- Creating a field group or field creates its group in the same transaction. Deleting one (already refused while matches use it) deletes its group and the group's assignments. `POST /api/sessions/{id}/copy-fields` creates groups for the fields it creates. Deleting a session deletes its groups, assignments and pit groups.

### 4.3 The `display_assignments` table

`(session_id, device_id)` → `group_id`, unique on `(session_id, device_id)`.

- Only devices whose role is `display_device` can be assigned (422 otherwise).
- Deleting a device or a group deletes its assignments. Changing a device's role away from `display_device` deletes its assignments in every session.
- The group must belong to the same session (422).

### 4.4 Following the active session

A display shows its group in the event's active session. When an admin makes another session active, every display switches to its group there. A display with no group in the active session shows its own name in large type and "Not set up for this session"; with no active session it shows "No session is running".

Devices stay paired for the whole event. A session at another venue pairs its own TVs; displays not assigned in that session are simply unused.

### 4.5 Copy displays from another session

`POST /api/sessions/{id}/copy-displays {source_session_id}` (admin), offered on the Displays page like "Copy fields from":

- Refused (409) if the target session already has a pit group or an assignment; 422 if the source is the same session or has no display setup; 404 for an unknown session.
- Audience groups: copies `screen`, `screen_settings` and `play_sounds`, matched by field group name.
- Pit groups: recreated with name, screen, settings and rotation; `division_id` is matched by division name (null when the source's division no longer exists or the event has one division).
- Assignments: recreated, matched by field group name (audience), field group and field name (field), or pit group name (pit). A device no longer paired or no longer a display is skipped.
- Returns `{unplaced: [{device_id, device_name, source_group_name}]}` for displays whose group has no match in the target session.

## 5. Screens

### 5.1 Field display (field groups)

Follows its own field. The match it shows is the earliest match on the field (by `scheduled_time`, then match order) that has no complete score. It ignores the next-match override.

- **Match Intro** (match not started): the match name as title (from the match label, for example "Qualification 37"), the field name, each alliance as a coloured block with one line per team (current session rank in its division or "–", number, name), and the time to its scheduled start: green while more than 30 s remain, yellow from 30 s to 0, red counting up after it ("3:12 late"). A match with no scheduled time (finals games) shows "Up next" without a countdown.
- **In Match** (phase is any running phase): the 3-2-1 count-in, then the period clock in very large type; "Driver control next" while `awaiting_driver`; a "Paused" banner while paused.
- **Match Over** (phase `ended`, not yet fully scored): "Match over" until the score is saved, then the next match.
- **Done:** "No more matches on this field".
- **Time-out:** a running time-out on its field group replaces all of the above (§6.4).

### 5.2 Audience and pit screens

| Key | Label | Audience | Pit | Shows | Settings |
|---|---|---|---|---|---|
| `match_intro` | Match Intro | ✓ | | The field group's next match (§6.1), as the field version, plus the field name | — |
| `in_match` | In Match | ✓ | | The field group's running match: clock in the centre, alliance teams in corner blocks, match name on top; "Match over" at 0:00 after it ends | — |
| `last_scored_match` | Last Scored Match | ✓ | | The most recently fully scored match on this field group: alliance blocks as in Match Intro, each alliance's score in large type | — |
| `teamwork_rankings` | Teamwork Rankings | ✓ | ✓ | Active session's rankings for the division: rank, team (number above name) and the game model's columns (head-to-head: win points, strength of schedule, record; cooperative: average score, matches) | — |
| `skills_rankings` | Skills Rankings | ✓ | ✓ | Event-wide skills rankings for the active session | `tab`: `overall` or a skills type key (default `overall`) |
| `upcoming_matches` | Upcoming Matches | ✓ | ✓ | The next unplayed matches: match, alliances, field, time | `count` 1–20 (default 3); `scope`: `field_set` or `division` (pit: `division` only) |
| `match_results` | Match Results | ✓ | ✓ | Fully scored matches, newest first, with both scores | — |
| `schedule` | Schedule | ✓ | ✓ | The division's whole match list with times | — |
| `elimination_bracket` | Elimination Brackets | ✓ | ✓ | The division's newest finals bracket in the active session: the single-elimination tree with each matchup's alliances, series score and winner, or score-chase standings in run order with the current run highlighted; "No eliminations yet" before one exists | — |
| `logo` | Logo | ✓ | ✓ | The event name, large (sponsor logos later) | — |

"The division" is the audience group's field group's division, or the pit group's division; with none (single-division event) it is every match and ranking with no division plus the sole division's.

Screens that can be longer than the TV (`teamwork_rankings`, `skills_rankings`, `match_results`, `schedule`) scroll on the device (§7.4).

### 5.3 Common frame

Every screen has a header bar with the screen title and the event name, with room on the left for a logo once sponsor logos exist. Colours and type come from the existing design system; red and blue mark the two alliances. The layout is sized from the viewport width so the same screen reads on a 24" monitor and a projector.

### 5.4 The screen registry

The server holds the one registry of screen keys (`services/display_screens.py`): each key's allowed group kinds and a validator for its settings. `PATCH` of a group's `screen`, `screen_settings` or `rotation` is checked against it: an unknown key, a key not allowed for the group's kind, or bad settings is a 422 naming the problem. The device app keeps a matching module per key, and the admin app a label per key (English and Chinese).

## 6. Match Control

### 6.1 The next match

- **The field group's next match** (what Start begins, and what the audience Match Intro shows): the queued override if set, else the earliest match on the field group (by `scheduled_time`, then match order) that hasn't started (`phase = not_started`). So while Q34 waits for its score, Q35 on the next field can start.
- **The override** is `field_sets.queued_match_id` (nullable). `PUT /api/field-sets/{id}/queued-match {match_id | null}` (admin) sets or clears it; the match must be on this field group and not started (422 otherwise). It is cleared when that match starts, when it gets a complete score, and when it is deleted (a schedule clear or rebuild).
- A full reset puts a match back to `not_started`, so it becomes eligible again.

### 6.2 The Match Control page

New admin nav item **Match Control** (`/match-control`), admin only, for the active session:

- **Field group tabs**, one per field group, the choice remembered in the browser.
- **Next match card:** "Next: Q35 · Field 2" with its alliances; **Change** opens a list of the field group's unstarted matches to set the override; **Clear** returns to schedule order.
- **Timer card:** the running match's clock and phase in large type, and its field. **Start** starts the next match (disabled while a match on this field group is running, which the server already refuses); **Start Driver** while awaiting driver; **Pause** / **Resume**; **End Early** (asks first); **Reset**, which asks "Reset this period or the whole match?".
- **Saved Match card:** the last fully scored match on the field group with its scores, so the operator can check it before showing Last Scored Match.
- **Audience screen buttons:** one per audience screen (§5.2), the current one highlighted, plus the selected screen's settings below them (for example the skills tab or the upcoming count), which apply immediately. Pressing a button sets the screen on this field group's audience group.
- **Time-out:** **Time-out** with a length (default 3:00) and **Cancel time-out** while one runs.
- **Play sounds** switch for the audience group.

Everything updates over the live connection, so two admins see the same state.

### 6.3 Automatic switches (server side)

So they happen with no admin page open:

- `POST /api/matches/{id}/start` sets every audience group on the match's field group to `in_match` (keeping its settings), clears the override and any time-out, and broadcasts the changes.
- After the match ends the audience stays on In Match ("Match over" at 0:00) until an admin picks another screen. Picking another screen mid-match is allowed; field displays keep the timer either way.

### 6.4 Time-out

`field_sets.timeout_deadline` (UTC, nullable). `POST /api/field-sets/{id}/timeout {seconds}` (admin; 10–600, default 180) starts or restarts it; `DELETE` cancels it; starting a match cancels it. While it runs, the field group's audience and field displays show a full-screen "Time-out" countdown, then return to what they showed. An expired deadline is simply ignored; nothing needs to clear it.

### 6.5 Sounds

Audience displays whose group has `play_sounds` on play short tones on: each count-in beat, the start of a period, 30 s left in a period, the end of a period, the end of the match, and the end of a time-out. Tones are generated in the browser (Web Audio), so there are no audio files to license. A browser that blocks autoplay shows a small "Click to enable sound" note until someone clicks once.

## 7. Device app

### 7.1 Display mode

A paired device whose role is `display_device` runs display mode instead of the "Paired as" home screen. Scorer, referee, judge and check-in devices keep the placeholder until their own specs. The device app gains TanStack Query for screen data; it still has no router.

### 7.2 `DisplayRoot`

Reads `GET /api/displays/me` and re-reads it on `display_changed`, `field_set_changed`, `active_session_changed` and every socket reconnect. Then it mounts:

- the field display (§5.1) for a field group;
- the current screen for an audience group, with the time-out overlay;
- the rotation runner for a pit group (or its single screen).

`display_identify` for this device shows its name full-screen for 10 seconds over whatever is showing.

### 7.3 Screen modules

`src/display/screens/<key>.tsx`, each exporting `{key, Component, scrolls}`; a registry maps keys to modules. A screen fetches its own data from the existing REST endpoints and refreshes on the existing live events (`score_saved`, `match_phase_changed`, `match_paused`, `match_resumed`, `match_reset`, `new_match_created`, `ranking_updated`, `skills_changed`, `finals_changed`, `qualification_status_changed`). An unknown key (an older device app after an update) renders `logo`.

### 7.4 Scrolling and rotation

- `useAutoScroll`: scrolls a long list slowly at reading speed, pauses at the top and at the bottom, and loops. It reports when it has reached the bottom once.
- Rotation runner: shows each rotation entry in turn. A `scrolls` screen moves on once it has reached the bottom once; a list that fits, or a screen that doesn't scroll, moves on after the entry's `seconds` (default 20, 5–300).

### 7.5 Server clock

`useServerClock` measures the device's clock offset through `GET /api/time-sync` (half the round trip as the correction), re-measures every 10 minutes and on reconnect, and every countdown and colour band uses server time, because a TV's clock may be wrong.

### 7.6 Kiosk styling

Full-screen, no scrollbars, cursor hidden, type sized from the viewport width, nothing to click except the sound note.

## 8. Server API

All admin only, except `me`.

```
GET    /api/displays?session_id=          groups (with their displays and online state) and unassigned displays
POST   /api/displays/pit-groups           {session_id, name, division_id} -> group (201); 409 on a duplicate name in the session
PATCH  /api/displays/groups/{id}          {screen?, screen_settings?, rotation?, name?, division_id?, play_sounds?}
DELETE /api/displays/groups/{id}          pit groups only (409 for audience and field groups); 204
PUT    /api/displays/assignments          {session_id, device_id, group_id | null}
POST   /api/displays/{device_id}/identify 204; 404 for an unknown device
POST   /api/sessions/{id}/copy-displays   {source_session_id} -> {unplaced}
PUT    /api/field-sets/{id}/queued-match  {match_id | null}
POST   /api/field-sets/{id}/timeout       {seconds}
DELETE /api/field-sets/{id}/timeout
GET    /api/displays/me                   display devices only (403 otherwise)
GET    /api/finals?session_id=&division_id=   any role; the session's brackets for the division, newest first
```

- Fields not allowed for a group's kind (`name` on an audience group, `play_sounds` on a pit group, `rotation` on an audience group) are a 422.
- "Online" means the device has an open WebSocket (the existing device socket registry).
- `GET /api/displays/me` returns `{device: {id, name}, session_id, group}`. `session_id` is the active session or null. `group` is null when unassigned, else `{id, kind, name, field_set_id, field_id, division_id, screen, screen_settings, rotation, play_sounds, field_set: {queued_match_id, timeout_deadline}}`.
- Display read access: every endpoint a screen reads (matches, rankings, skills rankings, skills settings, finals, teams, divisions, field groups, fields, ranking settings, the event) must allow `display_device`. The plan checks each and widens any that don't.

### 8.1 Live events

On the active-session channel, unless stated:

- `display_changed {session_id, group_id}`: a group was created, changed or deleted, or its displays changed. `group_id` is null for a bulk change (copy displays).
- `field_set_changed {field_set_id}`: its override or time-out changed.
- `display_identify {device_id}`: sent only to that device's sockets.

These join the realtime event catalog and its wire-contract tests.

### 8.2 Audit

Group, assignment, override and time-out writes go through the generic audit hook like other tables.

## 9. Admin app: Displays page

New admin nav item **Displays** (`/displays`), admin only, for the active session, with a session picker to view or set up another:

- **Field groups:** each with its audience group (screen and settings, Play sounds, its displays) and its fields' groups (their displays).
- **Pit groups:** **Add pit group** (name, division). Each pit group's editor picks one screen or builds a rotation: an ordered list of screens, each with its settings and, for screens that don't scroll, its seconds; reorder, add, remove. Delete asks first.
- **Displays in a group** show name, online state, **Identify**, and a **Move to…** selector.
- **Unassigned displays:** every paired display with no group in this session, each with **Put in group…** and **Identify**.
- **Copy displays from…:** shown while this session has no pit groups or assignments; afterwards lists the displays it couldn't place.

The Devices page shows each display's group in the active session.

## 10. Errors and edge cases

- **Lost connection:** the screen keeps its last picture and shows a small "Reconnecting…" badge in a corner; running clocks keep counting to their last known deadline.
- **Screen data fails to load:** the screen shows its title and "Waiting for data" and keeps retrying; a display never goes blank.
- **Group removed or display unassigned:** "Not set up for this session" at once.
- **Role changed away from Display:** the existing 4403 close; the device signs in again and lands on its new screen.
- **Field renamed:** its group follows the field (the group is linked by id within the session; names only matter when copying between sessions).

## 11. Later work this design must leave room for

- **Skills field displays:** a `field` group on a skills field (or a shared group for several skills fields) showing the team and type the scorer picked, then the count-in and countdown. Comes with skills fields and skills timers.
- **New screens:** alliance selection, inspection status, slides, sponsor logos, the score-reveal screens. Each is a registry line, a device module and an admin label.
- **New automatic switches:** queueing, "show to teams" and "send to results" set screens through the same group update path as §6.3.
- **Kiosk links and the streaming overlay.**

## 12. Testing

### Server (pytest)

- Groups: created with field groups and fields (including copy-fields), deleted with them and with sessions; the startup self-heal creates missing ones and is idempotent.
- Registry: unknown screen, wrong kind and bad settings are 422; rotation validation; kind-specific fields.
- Pit groups: create, duplicate name 409, delete; audience and field groups can't be deleted.
- Assignments: one per session and device; only displays; group in the same session; removed on device delete, group delete and role change.
- Copy displays: every matching rule, the unplaced list, refusals (409, 422, 404).
- Next match and override: set, refuse a started or foreign match, cleared on start, on complete score and on delete.
- Automatic switch on start; time-out start, cancel, restart, cleared by a match start.
- `me` in every state: unassigned, no active session, each group kind, non-display caller 403.
- Display read access on every endpoint a screen reads.
- `GET /api/finals` list.
- Every new live event over a real `TestClient` WebSocket; `display_identify` reaches only its device.

### Vitest

- Each screen renders its data, its empty state and "Waiting for data".
- Field display: which match it shows (earliest not fully scored), the colour bands at 31 s, 30 s, 0 s and late, "Up next" without a time, each phase, Done, time-out overlay.
- The field group's next match (override first, then earliest not started).
- `useAutoScroll`'s bottom signal; the rotation runner (scrolling and timed entries, single screen); `useServerClock`'s offset; the sound triggers.
- Match Control: buttons for each phase, override change and clear, screen buttons and settings, time-out.
- Displays page: pit group editor and rotation, assignment, copy displays and its unplaced list.

### Playwright

Its own server with the device app (`startIsolatedServer` with `devicePort`):

- Pair two displays; put one on Field 1 and one on the audience group.
- Start the next match from Match Control: the audience switches to In Match and the field display counts in and down.
- Save the score: the field display moves to the field's next match; Last Scored Match shows the score.
- Override the next match, then Start begins it.
- A pit rotation moves to its next screen.
- A time-out shows on both displays and clears.
- Copy displays into a new session and make it active: the displays keep their places.
- An unassigned display shows its name and "Not set up for this session".
