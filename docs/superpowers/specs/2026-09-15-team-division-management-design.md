# Team & Division Management — Design

## Purpose

The second sub-project of the Admin UI (following the shell/auth/event-setup
sub-project). Lets a tournament admin set up divisions and enter/manage the
event's team roster: manual entry, a paste-friendly spreadsheet grid, and
CSV import/export. Explicitly does **not** cover sessions, field setup,
scheduler plugin selection, or schedule generation — that substantial
existing backend surface (`sessions`, `field_sets`, `fields`,
`schedule`) gets its own later sub-project.

## Scope boundary

**In scope:**
- Division management: create, rename, delete, an optional target team
  count per division (informational only, not enforced).
- Team roster management, tournament-wide (not per-division): manual
  entry, a spreadsheet-style grid with paste support, CSV template
  download, CSV export, CSV upload.
- Assigning teams to divisions: manual (per-team), and a balanced random
  assignment action, both for routine "spread unassigned teams" use and
  as the default response to a division being added or removed.
- New fields this sub-project adds to the data model: `Team.robot_name`,
  `Division.target_team_count`, and a uniqueness constraint on team
  number within the event.

**Out of scope (later sub-projects):**
- Session creation, field/field-set configuration, scheduler plugin
  selection, triggering schedule generation, viewing/editing a generated
  schedule.
- Live match control dashboard, finals brackets, device admission,
  rankings/reporting UI.

## Backend contract

### Data model changes

- `Team` (`server/src/tournament_server/models/team.py`) gains
  `robot_name: Mapped[str | None] = mapped_column(String(200), default=None)`.
  Gains `UniqueConstraint("event_id", "number", name="uq_teams_event_number")`
  — team number becomes a required, unique identifier within the event
  (matches how team numbers work in the real competitions this system
  supports). Existing columns (`number`, `name`, `organization`, `city`,
  `state`, `country`, `division_id`, `tiebreaker_seed`) are unchanged.
- `Division` (`server/src/tournament_server/models/division.py`) gains
  `target_team_count: Mapped[int | None] = mapped_column(default=None)`
  — purely informational (drives a "18 of 24 entered" display), never
  enforced as a cap.
- One new Alembic migration adds both columns and the unique constraint.
  Per this project's established migration pattern
  (`server/CLAUDE.md`'s "Database migrations" section), a `server_default`
  is not needed for the two new nullable columns (SQLite allows adding a
  nullable column with no default to a populated table); the unique
  constraint requires a table rebuild on SQLite (Alembic's
  `batch_alter_table`), consistent with how prior migrations in this
  repo have handled constraint changes.

### Endpoints

Existing, gaining `robot_name` on their schemas, and one behavioral
change from the new uniqueness constraint:
- `POST /api/teams`, `GET /api/teams`, `GET /api/teams/{id}`,
  `PATCH /api/teams/{id}` (`routers/teams.py`) — admin-gated writes,
  any-role reads. `TeamCreate`/`TeamUpdate`/`TeamRead` schemas gain
  `robot_name: str | None = None`. **Behavioral change:** with the new
  `(event_id, number)` uniqueness constraint in place, a `POST` with a
  number that already exists, or a `PATCH` that renumbers a team to one
  that already exists, must now be caught and returned as a clean `409`
  ("Team number already in use") rather than propagating a raw database
  `IntegrityError` as an unhandled `500`.
- `POST /api/divisions`, `GET /api/divisions` (`routers/divisions.py`).
  `DivisionCreate` gains `target_team_count: int | None = None`;
  `DivisionRead` gains the same field.

New:
- `DELETE /api/teams/{id}` — admin-only. `404` if not found. `409` if the
  team has any `SessionParticipation`, `Ranking`, `AllianceTeam`, or
  `BracketAllianceTeam` (checking whichever of these tables actually
  reference the team — see each model's foreign keys) row referencing it,
  with a detail message naming what's blocking deletion. Not expected to
  trigger in this sub-project's own workflows (no sessions/schedules
  exist yet when teams are being entered), but protects against deleting
  a team after a later sub-project has scheduled it into matches.
- `PATCH /api/divisions/{id}` — admin-only. Body
  `{name?: str, target_team_count?: int | None}`. `404` if not found.
- `DELETE /api/divisions/{id}` — admin-only. `404` if not found. Sets
  `division_id = NULL` on every team currently in that division (does
  **not** delete those teams), then deletes the division row.
- `POST /api/teams/bulk` — admin-only. Body:
  ```json
  {
    "rows": [
      {
        "number": "94927D",
        "name": "The Robot Warriors",
        "robot_name": "Ironclad",
        "organization": "St Catherine School",
        "city": "Springfield",
        "state": "IL",
        "country": "USA",
        "division": "Division A"
      }
    ]
  }
  ```
  `division` is a human-readable division **name** (not an id) — the row
  formats produced by CSV export and by the grid are both
  human-readable, so this endpoint is the single place name-to-id
  resolution happens. Matching is case-insensitive (e.g. a CSV with
  `"division a"` matches an existing `"Division A"`) so an admin
  hand-editing a CSV in a text editor doesn't get tripped up by
  capitalization. `division` omitted or empty means unassigned
  (`division_id = NULL`). Upserts by `(event_id, number)`: a matching
  existing team is updated in place; no match creates a new team.
  Response is per-row:
  ```json
  {
    "results": [
      {"row_index": 0, "status": "created", "team": { ...TeamRead... }},
      {"row_index": 1, "status": "updated", "team": { ...TeamRead... }},
      {"row_index": 2, "status": "error", "error": "Unknown division: 'Division Z'"}
    ]
  }
  ```
  Always `200` (never fails the whole batch for a partial failure) —
  each row's outcome is independent, so the admin can fix just the
  failed rows and re-save. Row-level validation errors: missing
  `number`/`name` (required), unrecognized `division` name.
- `POST /api/divisions/randomize` — admin-only. Body
  `{"scope": "unassigned" | "all"}`. `404` if the event has no
  divisions yet (nothing to assign into). `scope: "unassigned"` only
  touches teams with `division_id IS NULL`; `scope: "all"` reassigns
  every team in the event. Both use the same balanced-shuffle algorithm
  (see below), returns the updated `TeamRead` list for every team it
  touched.

### Balanced-shuffle algorithm

Given the set of teams to (re)assign and the current list of divisions:
shuffle the teams into random order, then deal them round-robin across
the divisions (team 1 → division 1, team 2 → division 2, ..., wrapping
around) — this keeps division sizes as even as possible (differing by at
most 1) while still being random about *which* teams land where. For
`scope: "all"`, "the teams to assign" is every team in the event,
completely overwriting existing `division_id` values (a deliberate
choice — see the design discussion below). For a single team's "Random"
division choice at creation time, the same balanced logic applies with a
set of exactly one team: assign to whichever division currently has the
fewest teams (ties broken randomly).

**Why `scope: "all"` reshuffles everyone, not just newly-affected teams:**
considered scoping it to only the teams actually orphaned by a division
delete (or, for an add, leaving existing placements untouched) — this
would preserve any manual placements the admin has already made.
Rejected as the default because it's meaningfully more complex (tracking
"which teams were manually placed vs. randomly placed" isn't information
this system keeps), and because a full reshuffle is easier to reason
about and explain in a confirmation dialog ("this will randomly
reassign all N teams across divisions") than a partial one whose exact
boundary an admin has to guess at. The confirmation dialog is the
mitigation for the "I hand-placed some teams" case — an admin who wants
to preserve manual placements simply declines the reshuffle prompt and
redistributes by hand instead.

## Frontend

### Routes

- `/divisions` — new route, admin-only, added as a sibling in
  `router.tsx`'s existing children array (alongside `events/setup`,
  `settings/roles`). Lists divisions (name, team count vs.
  `target_team_count` if set, e.g. "18 / 24"), add/rename/delete forms.
  Delete and (when teams already exist) create both show a confirmation
  dialog before calling `POST /api/divisions/randomize` with
  `scope: "all"` — "Yes, reshuffle everyone" is the default/recommended
  button; declining leaves teams as they are (delete still unassigns the
  deleted division's own teams unconditionally, since they can't keep
  pointing at a division that no longer exists — the choice is only
  about whether to *then* reshuffle everyone else too).
- `/teams` — new route, admin-only, added as the same kind of sibling.
  One `react-data-grid` for the whole event's roster (not per-division).

### The teams grid

Columns: Number, Name, Robot Name, Organization, City, State, Country,
Division. The Division column is a dropdown-editable cell listing every
division by name plus "(unassigned)"; it is **hidden entirely** (not
just disabled) when the event has exactly one division, since a division
column is meaningless information in that case. A division filter above
the grid defaults to "All divisions" and is likewise hidden when there's
only one division.

Toolbar: "Randomly assign unassigned teams" (disabled when there are no
unassigned teams, or fewer than 2 divisions exist), "Download CSV"
(exports whatever the current filter shows — all teams, or one
division), "Download blank template" (fixed header row, no data rows,
no backend call — a static client-side constant), "Upload CSV," "Save
changes" (disabled when there are no unsaved edits).

**CSV columns always include Division**, even when the on-screen grid
is currently hiding the division column/filter for a single-division
event — a CSV is a portable file that might get reused for a
differently-configured event later (or hand-edited to add a second
division's worth of teams), so leaving Division out of the file format
itself would be a trap. Only the *on-screen grid* applies the
hide-when-single-division rule; the template and every export always
have all 8 columns (Number, Name, Robot Name, Organization, City,
State, Country, Division), with Division simply blank in every row for
a single-division event's export.

**Editing model:** typed edits and pasted data (multi-cell paste from
Excel/Sheets/a CSV file's contents, or a CSV file picked via "Upload
CSV") populate/modify grid rows **locally only** — nothing is sent to
the backend until "Save changes" is clicked, which POSTs every new or
modified row to `/api/teams/bulk` in one call. This is deliberate: it
gives the admin a chance to review a large paste or CSV import before
committing it, and it means CSV upload and grid paste share the exact
same commit path and the exact same error-reporting UI (see below) —
there is no separate "CSV import" code path, just "populate the grid,
then Save." **Row delete is the one exception**: clicking a row's delete
icon shows a confirm dialog and, on confirm, immediately calls
`DELETE /api/teams/{id}` — deletion is destructive enough that batching
it into a bulk save (where it could be silently included in a large,
under-reviewed commit) is the wrong default.

**Paste parsing:** `papaparse` parses pasted clipboard text (tab-
delimited, matching what Excel/Sheets put on the clipboard) and uploaded
CSV files (comma-delimited) with the same library, so quoting/escaping
(e.g. a city name containing a comma) is handled correctly in both
paths rather than by hand-rolled splitting.

**Error reporting:** after "Save changes," `/api/teams/bulk`'s per-row
response drives the UI: rows that succeeded are cleared from "unsaved"
state (now reflecting the server's canonical data); rows that errored
stay in the grid with a highlighted cell/row and the server's error
message shown inline (e.g. as a tooltip or an adjacent error column),
plus a summary banner ("22 saved, 2 need fixing"). The admin fixes the
highlighted rows and saves again — no separate "retry" flow, "Save
changes" always just re-submits whatever's currently unsaved.

### i18n, accessibility

Every string introduced here goes through `react-i18next` with `en` and
`zh` entries from the start, per this project's established pattern.
`react-data-grid` ships its own keyboard navigation; the grid's
container gets an accessible label, and the toolbar's icon-only buttons
(delete, etc.) get `aria-label`s — consistent with this project's
WCAG 2.1 AA requirement.

## Data flow

`GET /api/teams` and `GET /api/divisions` load via TanStack Query on
mount; both queries are invalidated after a successful bulk save, a row
delete, a division create/rename/delete, or a randomize action, so the
grid and the divisions list always reflect the server's current state
after any mutation. No new WebSocket events are introduced by this
sub-project — team/division data isn't part of live match state, and
multi-admin concurrent roster editing (two admins editing the grid at
once) is out of scope; the "last save wins" semantics of a plain
TanStack Query refetch are accepted as sufficient here.

## Error handling

- Division delete/create redistribution confirmation: covered above.
- Bulk upsert: per-row errors, covered above. A completely empty upload
  (CSV with header only, or an empty paste) is a no-op, not an error.
- Team delete blocked by existing scheduling data: the `409`'s detail
  message is shown as an inline error near the row's delete icon (a
  toast/banner, not a silent failure).
- Network/transient errors on any of these screens surface through the
  existing `TransientErrorBanner` (built in the previous sub-project),
  which already exists in `AppShell` for exactly this purpose.

## Testing

**Backend (pytest, real FastAPI + temp-file SQLite, per this project's
testing policy):**
- Migration: adds both new columns and the unique constraint cleanly to
  a populated `teams`/`divisions` table.
- `Team.number` uniqueness: a second `POST /api/teams` with a duplicate
  number within the same event is rejected.
- `DELETE /api/teams/{id}`: success case; `409` when the team has
  participation/ranking/alliance history (one test per referencing
  table).
- `PATCH /api/divisions/{id}`: rename, set/clear target count.
- `DELETE /api/divisions/{id}`: unassigns (not deletes) its teams.
- `POST /api/teams/bulk`: create-only batch, update-only batch, mixed
  create+update+error batch (verify partial success — the two good rows
  commit even though the third has a bad division name), unknown
  division name produces the row-level error, a division name differing
  only in case matches correctly, missing required field produces the
  row-level error, upsert-by-number actually updates existing fields
  rather than creating a duplicate.
- `POST /api/divisions/randomize`: `scope: "unassigned"` only touches
  unassigned teams; `scope: "all"` touches every team; resulting
  division sizes differ by at most 1; `404` when no divisions exist.

**Frontend unit (Vitest):**
- The CSV/paste-parsing helper (shared between upload and paste)
  against sample TSV and CSV input, including a quoted field containing
  a comma.
- Grid row-level error rendering given a mixed bulk-upsert response.
- The single-division column/filter-hiding rule.

**E2E (Playwright, per this project's policy and the established
pattern from the previous sub-project — a shared event-bootstrap
constant, real backend + real Vite dev server):**
- Create two divisions, add teams via the grid one at a time, verify
  they appear with the right division.
- Paste multi-row tab-delimited data into the grid, Save, verify all
  rows land correctly.
- Download the blank template, download a CSV of current teams, edit
  it, upload it back, verify the update took effect (upsert, not
  duplicate).
- Delete a team; delete a division and confirm the redistribution
  prompt reassigns its former teams.
- With only one division configured, verify the division column/filter
  are not rendered anywhere on `/teams`.
