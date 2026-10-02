# Fields, Schedule Generation, and Matches Admin UI Design

## Context and motivation

The backend fully supports `FieldSet`/`Field` management and multi-round schedule generation (`POST /api/schedule` with `phases`, multi-day `time_blocks`, `dry_run`, cycle-time warnings; `DELETE /api/schedule` per round type — see `docs/superpowers/specs/2026-09-26-multi-round-scheduling-design.md` and `server/CLAUDE.md`'s "Scheduling", "Time-based scheduling", and "Multi-division scheduling" sections). None of it has admin UI. The session check-in spec (`docs/superpowers/specs/2026-09-29-session-checkin-design.md`) deliberately split this off as its second sub-project; that first sub-project has shipped, giving each session a detail layout (`SessionDetailLayout.tsx`) with a tab strip that currently holds only Check-In.

Nothing downstream of scheduling (scoring, rankings, finals) is reachable from the UI until an organizer can generate a schedule, so this is the next screen set to build.

**Intended outcome:** an organizer goes from a session with checked-in teams to a generated, timed schedule without touching the API; can iterate on match counts and timing with dry-run previews before committing; can see the resulting matches; and can clear and regenerate a round when something is wrong.

**Decisions made during design (user-confirmed):**

- Three new tabs inside a session: **Fields · Schedule · Matches**, alongside the existing Check-In tab (chosen over a step-by-step wizard and over a single combined tab).
- Full FieldSet support, including assigning a FieldSet to a Division, not just a flat field list.
- Timing via time blocks, each block bounded by an end time *or* driven by a fixed cycle time.
- Existing rounds shown with per-round status and an explicit Clear action; clearing a round with scored matches requires typing the round name.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real FastAPI `TestClient` and real temp-file SQLite, in the same commit as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage for user-facing flows — no mocking at the HTTP/WebSocket boundary for E2E.
- No destructive migrations. No schema change may destroy existing data. (This spec needs no schema change.)
- Every user-facing string goes through `useTranslation()`/`t(...)` in both `en`/`zh` `admin.json` files — no bare string literals.
- Follow this app's existing conventions: TanStack Query for server state, `InlineEditableText` for inline renames, `react-data-grid` (with the shims `frontend/CLAUDE.md` documents) for large tables, native `<input type="date">`/`<input type="time">`/`<select>` for date/time entry.
- Existing callers of every changed endpoint keep working, except the one deliberate contract loosening called out in Section 1.

---

## Section 1: Backend additions

All small, all beside existing endpoints. No migrations.

### `GET /api/event/match-format`

`require_any_role`. Returns the event's selected game plugin's scheduling-relevant format:

```json
{
  "round_types": ["practice", "qualification", "elimination"],
  "teams_per_alliance": 2,
  "alliance_count": 2,
  "match_duration_seconds": 120
}
```

`match_duration_seconds` is `autonomous_seconds + driver_seconds` — the same value `routers/schedule.py` already computes for its cycle-time warning. 404 if no event exists; 422 (`"No game plugin has been selected for this event"`, the same message `POST /api/schedule` uses) if none is selected; 500 if the selected plugin isn't loaded (same as `POST /api/schedule`).

### Field and FieldSet editing

- `PATCH /api/fields/{id}` — body `{"name": str}`; renames. `require_admin`. 404 if missing. Name is stripped; empty name is 422.
- `DELETE /api/fields/{id}` — `require_admin`. 404 if missing. **409** (`"Field has scheduled matches; clear the schedule first"`) if any `Match.field_id` references it. Otherwise deletes; 204.
- `PATCH /api/field-sets/{id}` becomes a true partial update, matching `PATCH /api/sessions/{id}` and `PATCH /api/teams/{id}`: `FieldSetUpdate` gains optional `name`, and both `name` and `division_id` become optional, written only when present (`model_dump(exclude_unset=True)`). `{}` is a no-op 200. Explicit `"division_id": null` still clears the assignment; explicit `"name": null` or an empty name is 422. **Deliberate contract loosening:** `division_id` is currently a *required* key here (see `server/CLAUDE.md`'s "Multi-division scheduling"); no frontend calls this endpoint yet, so the change is safe. Update the test pinning the old required-key behavior and the `server/CLAUDE.md` paragraph in the same change.
- `DELETE /api/field-sets/{id}` — `require_admin`. 404 if missing. **409** if any `Match` references any of its fields, or any `FinalsBracket.field_set_id` references the set itself. Otherwise deletes the set and all its fields together; 204.

### `MatchRead.is_finals: bool`

`True` when `Match.finals_bracket_id` is not null. Needed because finals games share the plugin's ordinary `"elimination"` round type, so the round type alone can't separate schedule-generated rounds (which `DELETE /api/schedule` clears) from finals games (which it never touches — it filters `finals_bracket_id IS NULL`). Computed in `routers/matches.py`'s `_to_match_read`.

### `ResolvedTimeBlockRead.time_slot_count: int`

How many time slots were allocated to each resolved block, so the preview can show a projected finish time for an open-ended block (`end_time: null`): `start + time_slot_count × cycle_time_seconds`. `services/schedule_timing.py`'s `ResolvedBlock` dataclass already carries `time_slot_count`; this only copies it into the response schema. Present in both dry-run and real responses. Additive; existing response consumers are unaffected.

### Active session

No backend change. The UI's "Set as active session" button calls the existing `POST /api/event/active-session` (`{"session_id": id}`).

---

## Section 2: Session header and Fields tab

### Session header (`SessionDetailLayout.tsx`)

- Tab strip becomes **Check-In · Fields · Schedule · Matches**, routes `/sessions/:sessionId/{checkin,fields,schedule,matches}`. The index redirect stays on `checkin`.
- Beside the session title: an **"Active session"** badge if `Event.active_session_id` equals this session's id; otherwise a **"Set as active session"** button with a one-line hint (this is the session the front-desk kiosk and live displays follow). On success, invalidate `["event"]`.

### Fields tab (`/sessions/:sessionId/fields`)

Data: `GET /api/field-sets?session_id=`, `GET /api/fields?session_id=`, `GET /api/divisions`.

- One **card per FieldSet**:
  - Header: set name via `InlineEditableText` (→ `PATCH /api/field-sets/{id}` with `{name}`), a **Division** `<select>` (→ `PATCH` with `{division_id}`), and a **Delete set** button with a confirm dialog.
  - Body: the set's fields, each with `InlineEditableText` rename (→ `PATCH /api/fields/{id}`) and a remove button (confirm), plus an **Add field** input + button (→ `POST /api/fields` with this set's explicit `field_set_id`).
- **Add field set** button below the cards (→ `POST /api/field-sets`, name required).
- **Empty session** (no sets): a single "Add your first field" input; `POST /api/fields` without `field_set_id`, which auto-creates "Main Fields".
- **Division control visibility**, mirroring the Teams screen:
  - Single-division event: the Division select is hidden entirely; sets stay unassigned, which is exactly what scheduling uses for an omitted `division_id`.
  - Multi-division event: options are "Unassigned" plus each division. An unassigned set shows the note "Not used for scheduling until assigned to a division", since the Schedule tab always schedules a specific division in that case.
- **Errors:** a 409 on delete shows inline on that card (the server's message). Rename/create failures follow `InlineEditableText`'s existing inline-error pattern.

---

## Section 3: Schedule tab (`/sessions/:sessionId/schedule`)

Top to bottom.

### 3.1 Division picker

Shown only for multi-division events; every section below is scoped to the selected division and every request carries its `division_id`. Single-division events show no picker and omit `division_id` (the backend resolves the sole division for teams and uses unassigned FieldSets).

### 3.2 Readiness checklist

Each item green when satisfied, otherwise a link to fix it:

1. A game plugin is selected (`GET /api/event`'s `game_plugin_name`) → Event & plugins.
2. The session has a timezone → Sessions (edit this session).
3. At least `teams_per_alliance × alliance_count` checked-in teams in this division (from `GET /api/sessions/{id}/participants` + `GET /api/teams`) → Check-In tab.
4. At least one FieldSet for this division (assigned to it, or unassigned in a single-division event) containing at least one field → Fields tab.

Preview and Generate are disabled until all four pass. (The server remains the authority; this checklist only prevents the obvious failures.)

### 3.3 Current rounds

From `GET /api/matches?session_id=`, excluding `is_finals`, filtered to the selected division, grouped by `round_type`. One row per round: round type, match count, scored count (`status == "completed"`), first and last `scheduled_time`.

- **Clear** per row → `DELETE /api/schedule?session_id=&division_id=&round_type=`.
- **Clear all rounds** (shown when more than one round exists) → one `DELETE` per round, sequentially. Needed because rounds generated together in one combined `phases` request share stored time blocks, and regenerating only one of them hits the server's overlap check (`server/CLAUDE.md`, "Accepted, stricter-than-originally-assumed limitation"). The confirm dialog says this in plain words.
- **Confirmation:** every clear asks for confirmation. If any targeted match is scored, the dialog states how many and requires typing the round name before the confirm button enables (for Clear all, the literal phrase `clear all`, localized).
- After a successful clear, invalidate `["matches", sessionId]` (the delete endpoint broadcasts nothing).

### 3.4 Generate form

- **Scheduler:** `<select>` from `GET /api/plugins/schedulers`; defaults to `balanced` when installed, else the first entry. Empty list → inline message that no scheduler plugin is installed (Preview/Generate disabled).
- **Phases:** ordered rows of (round type `<select>`, matches per team number input ≥ 1), each with move up/down and remove, plus **Add phase**. Round-type options come from `GET /api/event/match-format`'s `round_types`, excluding round types that already have matches in this division and excluding ones already chosen in another row. Default rows: `practice` × 1 then `qualification` × 6, each included only if available. At least one row required.
- **Timing mode** — one switch for the whole form, because the backend forbids mixing "calculate for me" blocks with an open-ended block:
  - *Fit into these windows* (default): every block is date + start + **end**; sent with `cycle_time: null`; the server computes cycle time.
  - *Fixed cycle time*: one form-level cycle time in minutes, sent as each block's `cycle_time` (seconds). Every block except the last requires an end time; the last block's end time is optional (blank → `end_time: null`, "run until done"). Known backend behavior, surfaced as-is rather than changed here: blocks with both an end time and a cycle time have fixed capacity, and the server 422s if that capacity is more than the schedule needs or (with no open-ended last block) less than it needs. The form's helper text says to leave the last block's end time blank to avoid this.
- **Time blocks:** rows of date (defaults to the session's `session_date`, else today), start time, end time; add/remove; at least one. Sent in ascending order. A live hint flags a fixed cycle time below `match_duration_seconds × 1.5` (the server's default `warn_below_multiplier`) before previewing.
- **Request:** always the `phases` shape (a single phase is valid), `time_blocks` always explicit (the implicit "start in five minutes" mode is not exposed), `excluded_team_ids` omitted.
- **Buttons:** **Preview** (`dry_run: true`) and **Generate** (`dry_run: false`). Preview is not required before Generate.

### 3.5 Preview / result panel

- Per phase: round type and match count (`phase_results`).
- Per resolved block: date, start, end, cycle time (shown as m:ss), and slot count; for an open-ended block, a projected finish of `start + time_slot_count × cycle_time_seconds`, labeled "projected finish".
- `cycle_time_warning`, when present, as a warning alert.
- Any input change after a preview marks the panel **"Out of date — preview again"** rather than hiding it.
- After a successful Generate: a success summary with a link to the Matches tab; invalidate `["matches", sessionId]`; the form resets to defaults for the remaining available round types.

### 3.6 Errors

Every 409/422 from `POST /api/schedule` is shown inline above the buttons, verbatim — the server's messages already name the failing phase's round type or the overlapping block. Network failures use the shell's existing transient banner.

---

## Section 4: Matches tab (`/sessions/:sessionId/matches`)

Read-only `react-data-grid` (no editable columns).

- **Data:** `GET /api/matches?session_id=`, `GET /api/fields?session_id=`, `GET /api/teams`, `GET /api/divisions`.
- **Columns:** Label (`P1`, `Q12`, `F1-2`), Time, Field (name), one column per alliance station (team numbers, comma-separated), Status.
- **Time** rendered in the session's timezone via `Intl.DateTimeFormat` with `timeZone`, never the browser's local zone; the date is included when matches span more than one calendar day (in that zone). Sessions with no timezone render in UTC with a "UTC" suffix.
- **Filters:** division (multi-division events only), round type, team search (number or name; matches any team in any alliance).
- **Sort:** `scheduled_time`, then label. Finals games (`is_finals`) are included.
- **Empty state:** "No matches yet" with a link to the Schedule tab.

### Live updates

The Schedule and Matches tabs subscribe via `useRealtimeChannel` to `/ws/session/{sessionId}` (admin-only channel) and invalidate `["matches", sessionId]` on `new_match_created` and `score_saved`. Clearing has no broadcast; the clearing client invalidates its own query.

---

## Testing strategy

- **Backend (pytest):** `GET /api/event/match-format` (success, no plugin 422, no event 404, non-admin role allowed); `PATCH`/`DELETE /api/fields/{id}` (rename, empty-name 422, delete, 409 when a match references it, 404); `PATCH /api/field-sets/{id}` partial semantics (`{}` no-op, name only, division only, explicit null division clears, null/empty name 422) and the updated old-contract test; `DELETE /api/field-sets/{id}` (cascades its fields, 409 for a referenced field, 409 for a finals bracket, 404); `MatchRead.is_finals` for qualification vs. finals matches; `time_slot_count` present and summing to the total slots, for both dry-run and real responses; admin-only 403s for every new write endpoint.
- **Frontend unit (Vitest):** session header badge vs. button; Fields tab (cards, add/rename/remove, division select hidden for one division, unassigned note, inline 409); Schedule tab (checklist gating, round-type option filtering, default phases, request built correctly in each timing mode, open-ended last block, preview out-of-date marking, typed-confirm for scored clears, Clear all issuing one DELETE per round); Matches tab (timezone formatting incl. multi-day date display, filters, empty state, realtime invalidation).
- **Playwright E2E** (golden path + important edge cases):
  - Golden path: add fields, set the session timezone, check teams in, preview, generate practice + qualification, see matches on the Matches tab, Clear all, regenerate.
  - Checklist blocks Preview/Generate when the division has no fields.
  - A round with a scored match requires typing its name before Clear enables.
  - Deleting a field that has matches shows the 409 message.
  - Two divisions, each generating on its own assigned FieldSet.
  - **E2E environment notes for the plan:** the E2E backend starts with an empty plugins root, so the spec must install the `balanced` scheduler plugin itself (a zip-building fixture alongside `buildExampleGamePluginZip`, uploaded via `POST /api/plugins/schedulers`, tolerating 409) and must tolerate the example game plugin already being selected by `eventSetup.spec.ts` (game-plugin selection is immutable per event). All E2E specs share one event, so the two-division scenario must restore the event to its prior division count afterward so later specs (Teams screens hide division controls for one division) aren't affected.

## Out of scope (explicitly deferred, not built in this spec)

- Editing, moving, or swapping individual matches; drag-to-reschedule.
- Partial regeneration that preserves already-scored matches (see the `partial-schedule-regen-preserving-scores-deferred` memory).
- Finals bracket UI (starting brackets, alliance selection, advancement).
- Inspections (see the `inspections-subsystem-deferred` memory).
- Printing or exporting schedules.
- A history/list of past schedule generations.
- Excluding specific teams from a generation (check-in already controls who is scheduled).
- Exposing the backend's implicit "start in five minutes" timing mode.
