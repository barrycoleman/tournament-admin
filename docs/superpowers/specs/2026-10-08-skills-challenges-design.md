# Skills Challenges Design

## Context and motivation

A **skills challenge** is one team alone on a field, scoring as many points as it can. It is usually the same game with modified rules, and sometimes it is scored differently. The core architecture spec (`2026-08-28-core-server-plugin-architecture-design.md`) reserved a `SkillsAttempt` table and two game-plugin functions (`skills_scoresheet_schema()`, `calculate_skills_score()`) for it. Nothing else exists: there are no models, endpoints or UI. The plugin contract also has no idea of skills *types*.

The season rankings spec (`2026-10-06-season-rankings-design.md`) built the Season Rankings page with a single Teamwork tab and left room for the skills tabs this spec adds.

**Intended outcome:**
- The game plugin decides whether skills exist, which types there are (e.g. "Autonomous", "Driver"), and how each is scored.
- An event may run no skills, only skills, or both.
- At the skills field, someone records each team's attempts on a Skills page in the admin app, filling in the plugin's scoresheet.
- Session and season skills rankings appear as tabs on the rankings pages.

**Decisions made during design (user-confirmed):**

- **Entry happens in the admin app now, and in the scorer app later.**
  - In this spec, each session gets a Skills page in the admin app. It is the first screen that draws a plugin scoresheet.
  - The future scorer app must also score skills, alongside teamwork matches. A field scorer chooses skills, picks the team and, when the game has more than one type, the type, then gets a scoring page like a teamwork match's, specific to that type. See 4.5.
- **Attempts allowed:** an event-wide number per type (default 3), which a session may override.
- **One event switch**, "Run skills challenges", is off by default. With it off, skills pages and tabs are hidden and new attempts are refused. An event that runs only skills simply never schedules qualification matches.
- **Every attempt is recorded.**
- **Session Overall** = the sum of the team's best attempt in each type in that session.
- **Season Overall** = the team's best session Overall. Bests from different sessions are never mixed. For example, S1 34+20=54 and S2 24+28=52 give a season score of 54.
- **Season per-type** = the team's best attempt of that type across all sessions.
- **Tie-break (fixed, generic):**
  - Overall:
    1. each type's best, in the plugin's priority order;
    2. then the sum of second-best attempts across types;
    3. then the sum of third-best, and so on, as deep as the most attempts any type allows.
  - Per-type: best, then second-best, then third-best, and so on.
  - Teams still level share the rank.
- **Skills are ranked across the whole event**, never per division.
- **Only teams checked in for the session** may record attempts.
- **Corrections are admin only.**
  - An admin can edit an attempt, which re-scores it and keeps its place, at any time, including in past sessions.
  - An admin can delete an attempt, which gives the team that attempt back.
  - Once a scorer or referee has submitted an attempt, they cannot edit or delete it. They ask an admin.
  - **The same rule now applies to teamwork match scores** (Section 3.6): once a match alliance's score has been submitted, only an admin can change it.
  - An attempt that happened but scored nothing is saved as 0 and uses up an attempt.
- **Plugin contract:** types become a function argument (approach 1). See Section 2.
- **The attempts table has a team filter** that narrows as you type. The use case is an admin finding what was recorded for one team in order to fix an error.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit and integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage of its user-facing flows, with no mocking at the HTTP/WebSocket boundary in E2E.
- Schema changes go through the project's Alembic migration mechanism.
- Every user-facing string goes through `t(...)` in both the `en` and `zh` `admin.json` files.
- Plugin interface changes update the `tm test-plugin` conformance tool, the bundled sample plugin and the test fixture plugins in the same change.

## Section 1: Data model

### 1.1 `skills_settings` (new table)

One row per event, created on first write. Reads before then return the defaults.

| Column | Type | Meaning |
|---|---|---|
| `event_id` | FK, unique | The event |
| `enabled` | bool, default false | The "Run skills challenges" switch |
| `attempts` | JSON, default `{}` | Map from type key to allowed attempts, e.g. `{"driver": 3, "autonomous": 3}`. A missing type means 3. |

### 1.2 `sessions.skills_attempts` (new nullable JSON column)

This is the per-session override, in the same shape as `skills_settings.attempts`. `NULL` means no override. A type missing from the override falls back to the event setting.

### 1.3 `skills_attempts` (new table)

| Column | Type | Meaning |
|---|---|---|
| `id` | PK | |
| `session_id` | FK `sessions.id` | |
| `team_id` | FK `teams.id` | |
| `skills_type` | str | The plugin's type key |
| `data_json` | Text | The filled-in scoresheet |
| `score` | int | Computed by the plugin on save and on edit |
| `plugin_name`, `plugin_version` | str | Which plugin scored it, as on `ScoreRecord` |
| `recorded_at` | UTCDateTime | When it was first saved |
| `updated_at` | UTCDateTime | When it was last saved or edited |

There is an index on `(session_id, team_id, skills_type)`.

- The core spec's sketch included `division_id` and `attempt_number`. **Both are dropped.** `division_id` goes because skills are ranked event-wide. `attempt_number` goes because numbers are derived for display: a team's attempts of one type, ordered by `(recorded_at, id)`, are numbered 1, 2, 3, ... After a delete, later attempts move up one place.
- **Attempt limit:** a new attempt is allowed while the team's count for that session and type is below the effective allowed number. Lowering the number after attempts exist keeps those attempts and refuses only new ones.
- Deleting a session deletes its skills attempts, using the same deletion path as its other live data.

### 1.4 Rankings are computed when read

Skills rankings are not stored. They are bests, sums and a sorted-list comparison over a small number of rows, so they are computed on each request. Nothing can go stale after an edit or delete, and no recompute step exists. The ranking function is a pure service function that Awards can reuse later.

## Section 2: Plugin contract and calculations

### 2.1 Game-plugin functions

| Function | Change |
|---|---|
| `skills_types() -> list[dict]` | **New, required.** Each item is `{"key": str, "label": str}`, listed in tie-break priority order. Keys are unique and match `^[a-z0-9_]+$`. Labels are non-empty. An empty list means the game has no skills. |
| `skills_scoresheet_schema(skills_type: str) -> list[dict]` | **Gains the type argument.** It uses the same field rules as `scoresheet_schema()`. |
| `calculate_skills_score(skills_type: str, scoresheet: dict) -> int` | **Gains the type argument.** |

- `skills_types` is added to `REQUIRED_GAME_PLUGIN_FUNCTIONS` in `plugin_registry/loader.py`.
- Labels are plain strings, like plugin field labels today.

**Conformance (`tm test-plugin`):**
- It checks the shape of `skills_types()`: a list of dicts with exactly `key` and `label`, valid and unique keys, and non-empty labels.
- For each type, it checks that `skills_scoresheet_schema(type)` is valid under the existing scoresheet rules, and that `calculate_skills_score(type, sample)` returns an `int` and is deterministic on the sample sheet built from field defaults.
- An empty type list passes and skips the per-type checks.

**Sample plugin** (`server/plugins/games/sample_cooperative`):
- It returns two types: `autonomous` ("Autonomous"), then `driver` ("Driver").
- Each has the existing single `score` counter field.
- Both score as the field value.

**Test fixture plugins** under `server/tests/fixtures/plugins/games/` are updated to the new signatures.

### 2.2 Scoresheet validation (server-side, generic)

When an attempt is created or edited, the server validates `data` against `skills_scoresheet_schema(skills_type)` before calling the plugin. No plugin code runs for this check. The rules are:

- **Fields:** every schema field must be present, and no other keys are allowed.
- **`integer`:** must be an `int` (not a bool), with `min ≤ value ≤ max`, and `(value - min) % step == 0` when `step` is set.
- **`boolean`:** must be a bool.
- **`enum`:** the value must be one of the field's `options` values.

Failures return **422** with `{"detail": "...", "violations": [{"field": name, "message": ...}]}`, with one entry per bad or missing field and one per unknown key.

### 2.3 Ranking keys

All rankings are computed by one pure function. Its inputs are the attempts for the scope (one session, or all sessions), the plugin's ordered type keys, and the effective allowed attempts per type. Let a team's **type list** for a session be its attempt scores of that type, sorted descending.

- **Session, one type:**
  - **Key:** the type list.
  - **Displayed score:** the first entry.
  - **Comparison:** keys are compared entry by entry, and a missing entry ranks below any score, including 0.
  - **Listed:** teams with no attempts of that type are not listed.
- **Session Overall:**
  - **Score:** the sum over types of each type list's first entry, where a type with no attempts adds 0. A team with at least one attempt in the session is listed.
  - **Key:** `(score, best of type 1, best of type 2, …, sum of second entries across types, sum of third entries, …)`. It runs to depth *D*, the largest effective allowed attempts among the types.
    - In a type best, a missing best ranks below 0.
    - In a depth sum, a type with no entry at that depth adds nothing.
    - If no type has an entry at a depth, that position ranks below 0.
- **Season, one type, and Season Overall:**
  - The team's season key is its **greatest session key** for that tab, across all sessions in the event.
  - The displayed score, the attempts and the "from session" all come from that one session.
  - If two of a team's sessions have equal keys, the earlier session (by `session_date`, then id) is named.
  - For one type, this session is the one holding the team's best attempt of that type.
  - For season keys, *D* is the largest effective allowed attempts among the types across all sessions.
- **Rank:** rows are sorted by key, descending. Teams with equal keys share a rank, and the next rank skips (1, 2, 2, 4). Within a shared rank, rows are ordered by team number.

## Section 3: API

### 3.1 Settings

- **`GET /api/skills/settings`** (any signed-in role) returns `{"enabled": bool, "attempts": {key: int}, "types": [{"key", "label"}]}`. `attempts` covers every plugin type, with 3 filled in where unset. With no game plugin selected, `types` is `[]`.
- **`PUT /api/skills/settings`** (admin) takes `{"enabled": bool, "attempts": {key: int}}`.
  - **422:** a key is not a plugin type, or a value is not an integer from 1 to 20.
  - **409:** `enabled: true` while the plugin has no types: "This game has no skills challenges."
  - On success it returns the GET shape and broadcasts `skills_settings_changed`.
- **`GET /api/sessions/{id}/skills`** (any signed-in role) returns `{"types": [{"key", "label", "allowed"}], "override": {key: int} | null}`. It returns 404 if the session is unknown.
- **`PUT /api/sessions/{id}/skills`** (admin) takes `{"attempts": {key: int} | null}`. `null` clears the override. The 422 rules match the event settings. On success it returns the GET shape and broadcasts `skills_settings_changed`.

### 3.2 Scoresheets

- **`GET /api/skills/types/{key}/schema`** (any signed-in role) returns that type's field list. It returns 404 for an unknown type.

### 3.3 Attempts

- **`GET /api/sessions/{id}/skills/attempts`** (any signed-in role) returns every attempt in the session as `{id, team_id, skills_type, number, score, data, recorded_at, updated_at}`.
- **`POST /api/sessions/{id}/skills/attempts`** takes `{"team_id", "skills_type", "data"}` and returns 201 with the attempt.
  - **404:** unknown session.
  - **409:**
    - skills off: "Skills challenges are turned off for this event.";
    - team not checked in for this session: "Team {number} is not checked in for this session.";
    - no attempts left: "Team {number} has used all {n} {label} attempts.".
  - **422:** unknown type, unknown team, or scoresheet violations (2.2).
- **`PUT /api/skills/attempts/{id}`** (admin only) takes `{"data"}`, re-scores the attempt and keeps its place. It returns 404 if the attempt is unknown, 409 if skills are off, and 422 for scoresheet violations.
- **`DELETE /api/skills/attempts/{id}`** (admin only) returns 204. It returns 404 if the attempt is unknown and 409 if skills are off.

Admins may edit and delete in any session, past or active.

### 3.4 Rankings

**`GET /api/skills/rankings?tab={overall|<type key>}&session_id={id}`**, or `&season=true` in place of `session_id` (any signed-in role).
- It returns `[{"rank", "team_id", "score", "attempts": [int], "session_id"}]`.
- `attempts` is the team's attempt scores in that session, from best down. For Overall it is all types' attempts concatenated, each type's list in plugin order.
- `session_id` is the session the row came from, which is always set.
- **404:** unknown session or tab.
- **422:** both or neither of `session_id` and `season`.

### 3.5 Permissions

- **Settings and session overrides:** `admin`.
- **Create attempts:** the same guard as match score entry (`routers/scores.py`): scorers and referees on an admitted device, plus `admin` (which needs no device), so the admin app's Skills page can record attempts.
- **Edit and delete attempts:** `admin` only. Scorers and referees get 403: "Only an admin can change a submitted skills attempt."
- **Every read:** any signed-in role.

### 3.6 Teamwork score corrections become admin only

`POST /api/matches/{match_id}/alliances/{alliance_id}/score` currently upserts, so any scorer can overwrite an existing score. It changes as follows:

- If a `ScoreRecord` already exists for the alliance and the caller is not `admin`, the request is refused with **409**: "This score has already been submitted; ask an admin to correct it."
- The first submission from scorers and referees on an admitted device is unchanged.
- Admin submissions still create or overwrite, so corrections, including after finalizing qualification, still work from the admin side.
- Existing tests and E2E helpers that re-submit a score as a scorer are updated to correct it as admin.

### 3.7 Realtime

- **`skills_changed {"session_id"}`:** sent after an attempt is created, edited or deleted. It goes to the session channel and to the active-session channel, which is where Season Rankings listens.
- **`skills_settings_changed {"session_id": id | null}`:** sent after an event settings change (with `null`), or after a session override change (with that id). It goes to the active-session channel and, for an override, to that session's channel.

## Section 4: Admin UI

### 4.1 Event Setup

A new **Skills challenges** panel sits beside the ranking settings panel:
- the "Run skills challenges" switch;
- one number input per type (1–20), labelled with the plugin's labels;
- a Save button.

If the plugin has no types, the panel says "This game has no skills challenges" and the switch is disabled. Validation errors appear inline.

### 4.2 Session Skills page (`/sessions/:sessionId/skills`)

The tab sits in the session navigation beside Matches and Rankings, and is shown only while skills are on. Opening the address directly while skills are off shows "Skills challenges are turned off for this event" with a link to Event Setup.

- **Attempts line:** for example, "Autonomous 3 · Driver 3 (event setting)", or "(this session)" when overridden.
  - **Change for this session** opens a small form with one number per type.
  - **Use event setting** clears the override.
- **Record an attempt:**
  - **Team picker:** a searchable picker over teams checked in for this session, matched by number or name.
  - **Type buttons:** one per type, in plugin order. When the game has only one type, the buttons are hidden and that type is used.
  - **Attempt count:** "Attempt {n} of {allowed}".
  - **Scoresheet:** drawn from the type's schema. The widgets are `counter` (− value +, clamped to min/max), `toggle`, `select` and `radio`, each with its label, and an icon where the schema gives one.
  - **Save attempt:** posts the attempt, then shows "Saved: {score} points" and resets the sheet to defaults for the next run.
  - **Errors:** server field violations appear beside their fields. Other server errors appear above the button.
  - **No attempts left:** Save is disabled with "Team {number} has used all {n} {label} attempts."
- **Attempts table:**
  - **Rows:** one per team that has at least one attempt in the session, sorted by team number.
  - **Columns:** one per type, listing that type's attempt scores in order, padded with "—" up to the allowed count (e.g. "28 · 20 · —"), plus the session Overall.
  - **Find team:** a box above the table filters rows as you type. It matches the team number or name, as a case-insensitive substring. Clearing it shows every row. The filter survives live updates. With no matches, the table says "No teams match '{text}'".
  - **Editing:** clicking an attempt score opens that attempt's scoresheet in a dialog, pre-filled, with **Save**, **Cancel** and **Delete attempt**. Delete asks for confirmation and gives the attempt back.
  - **Live updates:** the table refreshes on `skills_changed`.
- **Live data:**
  - attempts and session setup refresh on `skills_changed` and `skills_settings_changed`;
  - the page's checked-in team list refreshes on the existing check-in events.

### 4.3 Rankings pages

- **Session Rankings** gains the tab strip that Season Rankings already uses. The tabs are **Teamwork | {type labels in plugin order} | Overall Skills**. The skills tabs appear only while skills are on, and Teamwork shows the existing view unchanged.
- **Season Rankings** gains the same skills tabs.
- **Each skills tab:**
  - **Table:** one, with no division grouping, and the columns Rank, Team, Score and Attempts. Attempts are listed from best down. Season tabs add a "From session" column with the session label.
  - **Rule sentence:** one sentence explaining the tab's rule.
    - **Overall:** "Sum of each team's best attempt in each type in one session. Ties go to the higher {type 1} best, then {type 2} best, then the higher second-best attempts, and so on."
    - **Per-type:** "Each team's best {label} attempt. Ties go to the higher second-best attempt, and so on."
    - **Season tabs** add: "Season scores come from the team's best session."
  - **Empty state:** "No skills attempts recorded yet."
- **Live updates:** skills tabs refresh on `skills_changed` and `skills_settings_changed`.

### 4.4 Shared scoresheet components

The scoresheet form and its widgets live in `frontend/packages/shared/src/scoresheet/`. They take a field list and a value map and know nothing about skills or the admin app, so the scorer app can reuse them for both skills and teamwork matches. Their UI strings come through the caller's `t(...)`. The admin app wires them to its translation files.

### 4.5 Requirements carried to the future scorer app

The scorer app is not built in this spec. When its spec is written, it **must** include skills scoring next to teamwork match scoring, using the APIs in Section 3:

1. A field scorer, signed in as scorer or referee on an admitted device, chooses between scoring a teamwork match and scoring a skills run.
2. For a skills run, they pick the team from the session's checked-in teams, then pick the skills type. The type step is skipped when the game has only one type.
3. They get a full scoring page for that type, like a teamwork match's scoring page, drawn from `GET /api/skills/types/{key}/schema` with the shared scoresheet components. Each type can have its own page because each has its own schema.
4. Saving posts to `POST /api/sessions/{id}/skills/attempts`. The page shows the attempt number and the attempts remaining, and the same 409/422 messages as the admin page.
5. Once saved, an attempt cannot be edited or deleted from the scorer app; it shows that corrections go through an admin. The same applies to teamwork match scores in the scorer app (3.6).

## Section 5: Error handling summary

| Situation | Result |
|---|---|
| Record, edit or delete with skills off | 409 |
| Scorer or referee edits or deletes an attempt | 403 |
| Scorer or referee re-submits an existing teamwork score | 409 |
| Team not checked in | 409; the team is missing from the picker |
| No attempts left | 409; Save is disabled with the reason |
| Scoresheet field out of range, wrong type, missing or unknown | 422 with per-field violations, shown beside the fields |
| Unknown type or team on create | 422 |
| Unknown session, attempt, schema type or rankings tab | 404 |
| Settings: unknown type key, or attempts outside 1–20 | 422 |
| Enable skills for a game without skills types | 409 |
| Rankings with both or neither of `session_id`/`season` | 422 |

## Section 6: Testing

**pytest:**
- **Ranking function:**
  - a missing type;
  - a missing entry ranking below 0;
  - three-way ties;
  - ties broken at depth 3 and beyond 3;
  - Overall with different allowed counts per type;
  - a season row taking the best session rather than mixing sessions (54 vs 52);
  - an equal-key season naming the earlier session;
  - shared ranks with skip numbering.
- **Scoresheet validation:** each data type and each failure (range, step, bool-as-int, enum option, missing, unknown).
- **API:**
  - settings defaults, update, 422s, and the 409 for a game with no skills;
  - session override set and cleared, with effective allowed values;
  - attempt create, edit and delete;
  - derived numbering after a delete;
  - every 409 and 422;
  - lowering the allowed number keeping existing attempts;
  - permissions by role and admitted device, including scorer/referee edit and delete refused with 403;
  - teamwork score re-submission refused for scorer/referee with 409 and allowed for admin;
  - both broadcasts;
  - session deletion removing attempts;
  - the rankings endpoint for every tab and both scopes.
- **Conformance:**
  - a valid plugin;
  - an empty type list;
  - duplicate or invalid keys;
  - an empty label;
  - an invalid schema for one type;
  - non-int scoring;
  - the sample plugin passing.
- **Migration:** the upgrade creates both tables and the column, and existing sessions have `skills_attempts` `NULL`.

**Vitest:**
- each scoresheet widget (including counter clamping);
- the record form (attempt count, disabled when used up, field errors, reset after save);
- the attempts table (filter as you type, no-match message, edit dialog, delete confirmation);
- the Event Setup panel (including the no-skills plugin);
- the session override form;
- the rankings tab strips (skills tabs hidden when off).

**Playwright** (real server):
- **Golden path:**
  1. enable skills;
  2. check in teams;
  3. record attempts for two types;
  4. confirm the Overall and type tabs on Session Rankings rank correctly;
  5. edit an attempt and see rankings change.
- **Edge cases:**
  - running out of attempts;
  - a session override;
  - an out-of-range field error;
  - deleting an attempt to get it back;
  - filtering the attempts table by team number;
  - a team not checked in being absent from the picker;
  - Season Rankings showing the best session's score, not a mix;
  - skills page and tabs hidden after turning skills off.

## Out of scope

- Building the scorer app. Its skills requirements are recorded in 4.5 so its own spec picks them up.
- A skills finalize or lock.
- Per-division skills rankings.
- Plugin-defined skills tie-breaks (`rank_skills`).
- Translated plugin labels.
- Awards. They get their own spec next and can call the skills ranking function.
- A live running score in the form before saving.
