# Awards — design

Date: 2026-10-09
Status: approved in brainstorming, awaiting written-spec review

## 1. Purpose

An event organizer hands out awards at the end of each session. Some are
**judged**: judges choose the winner. Others are **performance** awards:
the winner comes straight from results (teamwork rankings, finals, or skills
rankings). The organizer decides how many awards there are, names every
one, and for each performance award chooses where its winner comes from and
which placement wins it.

Examples:

- "Teamwork Champion" = finals placement 1 (both teams on the winning
  alliance get the award). Without finals: teamwork ranking position 1 (one
  team).
- "Teamwork Second Place" = finals placement 2.
- "Autonomous Skills Champion" = skills type `autonomous`, position 1.
- "Excellence Award" = judged, one winner for the whole event.

This spec covers award definitions, automatic winners, judged entry by
admins and judges, admin overrides, finalizing, a CSV export, and the admin
UI (including a limited view for the judge role).

## 2. Scope

In scope: the `Award` and `AwardWinner` models, the session finalize flag,
source resolvers for teamwork rankings, finals, and skills, the awards API,
the `awards_changed` WebSocket event, the admin app's Awards tab, and the
judge role's navigation in the admin app.

Out of scope (each is its own future spec):

- **Award plugins.** A new plugin type that examines every match in a
  session or season and picks winners (for example lowest score variance).
  The source registry in section 5 is where they will plug in.
- **A separate judges app** (for example a tablet SPA). The judge role uses
  the admin app's limited view from this spec.
- **Reveal mode** on the audience display: winners revealed one by one
  during the ceremony. `AwardWinner.presented` is reserved for it.
- **A season awards report** (awards per team across the season).
- **Tournament Finals** (finals across divisions). Until it exists, an
  event-scoped award cannot use finals or teamwork rankings. A workaround
  that works today: a separate "Championship" session with only the
  qualifying teams, a short qualification round, finals, and its own awards.
- Eligibility rules (for example "one judged award per team"). The UI
  warns; people decide. Performance awards are never limited.

## 3. Data model

### 3.1 `Award` (`models/award.py`, table `awards`)

One row per award definition in a session.

| Column         | Type | Notes |
|----------------|------|-------|
| `id`           | int, primary key | |
| `session_id`   | FK `sessions.id`, `ON DELETE CASCADE` | |
| `name`         | string(200), not null | free text; duplicates allowed |
| `description`  | string(2000), nullable | optional; shown in the UI and CSV |
| `position`     | int, not null | ceremony order within the session, 0-based |
| `scope`        | string(20), not null | `event` or `division` |
| `division_ids` | JSON list of int, not null, default `[]` | `division` scope only; empty = every division |
| `kind`         | string(20), not null | `judged` or `performance` |
| `source`       | string(30), nullable | performance only: `teamwork_ranking`, `finals`, `skills_overall`, `skills_type` |
| `skills_type`  | string(50), nullable | `skills_type` source only: the game plugin's skills type key |
| `basis`        | string(20), nullable | performance only: `session` or `season` |
| `placement`    | int, nullable | performance only: 1 or more |

Validation (422 on violation):

- `judged`: `source`, `skills_type`, `basis`, `placement` must be null.
- `performance`: `source`, `basis`, `placement` required; `placement >= 1`.
- `skills_type` is required for, and only allowed with, `source = skills_type`.
- `teamwork_ranking` and `finals` require `scope = division`.
- `finals` requires `basis = session`.
- `division_ids` must be empty for `scope = event`, and every id must be a
  division of the event.
- `name` is trimmed and must not be empty.

### 3.2 `AwardWinner` (`models/award_winner.py`, table `award_winners`)

A stored recipient. A **slot** is one award in one division (or the single
event-wide slot); it holds zero or more winner rows.

| Column            | Type | Notes |
|-------------------|------|-------|
| `id`              | int, primary key | |
| `award_id`        | FK `awards.id`, `ON DELETE CASCADE` | |
| `division_id`     | FK `divisions.id`, nullable | null for an event-scoped award |
| `team_id`         | FK `teams.id` | |
| `origin`          | string(20), not null | `judged`, `override`, or `finalized` |
| `override_reason` | string(500), nullable | required when `origin = override` |
| `presented`       | bool, not null, default false | reserved for reveal mode |
| `recorded_at`     | UTC datetime | |
| `recorded_by`     | string(200) | the acting role or device, as in other records |

Unique on `(award_id, division_id, team_id)`. All rows in one slot share
one `origin`. A judged slot holds at most one row. An override replaces the
slot's whole resolved team list with the admin's chosen teams (one or more).

### 3.3 `TournamentSession.awards_finalized_at`

New nullable UTC datetime. Null means awards are live; set means finalized.

### 3.4 Migration

One Alembic revision, `down_revision = "e9c3f7a1b5d2"`: create `awards` and
`award_winners`, add `sessions.awards_finalized_at` (batch mode). Downgrade
drops all three.

## 4. Slots and their state

For each award, its slots are:

- `scope = event`: one slot, `division_id = null`.
- `scope = division`: one slot per division in `division_ids`, or per
  division of the event when the list is empty, in division `id` order.

A slot's **winners** and **status**:

| Situation | Winners | Status |
|---|---|---|
| Judged, no row | none | `judged_pending` |
| Judged, a row | the stored team | `judged` |
| Performance, an `override` row | the stored teams | `overridden` |
| Performance, a `finalized` row | the stored teams | `finalized` |
| Performance, no row, resolver returns teams, result is final | resolved teams | `resolved` |
| Performance, no row, resolver returns teams, result can still change (finals in progress) | resolved teams | `provisional` |
| Performance, no row, resolver returns nothing | none | `no_result` |

`resolved` and `provisional` winners are computed on every read and are
never stored before finalizing.

## 5. Sources (`services/award_sources.py`)

A registry maps each `source` to a resolver:

```python
@dataclass
class Resolution:
    team_ids: list[int]      # empty = no result
    provisional: bool
    note: str | None         # e.g. "Unknown skills type"

def resolve(db, award: Award, division_id: int | None) -> Resolution
```

`SOURCES: dict[str, Callable[..., Resolution]]` holds one entry per source.
Award plugins add entries later. Resolvers read data only; they never write.

### 5.1 `teamwork_ranking`

The `Ranking` row for the slot's division with `rank == placement`:
`session_id = award.session_id` for `basis = session`, `session_id = null`
(season rankings) for `basis = season`. Returns that one team. Season basis
uses the season rankings as they stand when read (or when finalized); they
are stored as current totals only, so finalizing an old session late picks
up later results. The UI does not hide this; it is documented here.

### 5.2 `finals`

The session's `FinalsBracket` for the slot's division. No bracket: no
result. Placements:

- **Score chase:** the `FinalsResult` with `rank == placement`. Provisional
  until the bracket's status is `complete`.
- **Single elimination:** alliances are ordered by the round they lost in,
  later rounds first, and then by seed (lower seed number first). 1st is the
  final's winner, 2nd its loser, then semifinal losers by seed (3rd, 4th),
  then quarterfinal losers by seed, and so on. A placement resolves only
  once every matchup that decides it is decided; until then it has no
  result. There is no provisional state for single elimination.

Returns every team on the alliance (`BracketAllianceTeam`).

### 5.3 `skills_overall` and `skills_type`

`services/skills_ranking.rank_skills` on the `overall` tab or the
`skills_type` tab, over the session's attempts (`basis = session`) or the
whole season's (`basis = season`), exactly as `GET /api/skills/rankings`
computes them.

- Event scope: the event-wide list.
- Division scope: keep only teams whose `Team.division_id` is the slot's
  division, then renumber with the same rule `rank_skills` uses (tied rows
  share a rank; the next rank skips).

Returns every team at `rank == placement`, so a tie gives every tied team
the award. A `skills_type` the game plugin no longer defines, or skills
disabled for the event: no result, note "Unknown skills type" or "Skills
are not enabled".

## 6. API

All routes are under `/api`. Reads use `require_any_role`. Writes are
listed with their roles; `admin` always passes. Every write goes through
the audit log and ends with an `awards_changed` broadcast (section 6.5).
While `awards_finalized_at` is set, every write for that session except
`unfinalize` returns **409** "Unfinalize awards to make changes."

### 6.1 Definitions (writes admin only)

- `GET /sessions/{session_id}/awards` — roles: any. The session's awards in `position`
  order. Each award has its fields plus `slots`: `{division_id,
  division_name, status, winners: [{team_id, number, name, organization}],
  override_reason, note, warnings}`. The response also has
  `awards_finalized_at`. `warnings` lists stored winners no longer in the
  slot's division ("Team 123 is no longer in this division").
- `POST /sessions/{session_id}/awards` — create; appended at the end.
- `PATCH /awards/{award_id}` — edit. Changing `kind`, `scope`,
  `division_ids`, `source`, `skills_type`, `basis`, or `placement` deletes
  the award's stored winners. Name and description changes keep them.
- `DELETE /awards/{award_id}` — positions of later awards close the gap.
- `PUT /sessions/{session_id}/awards/order` — `{award_ids: [...]}`; must be
  exactly the session's award ids (422 otherwise).
- `POST /sessions/{session_id}/awards/copy` — `{from_session_id}`; appends
  copies of that session's definitions (not winners) in their order. 422
  when copying a session onto itself.

### 6.2 Winners

`PUT /awards/{award_id}/slots/{slot}` and `DELETE` on the same path, where
`{slot}` is a division id or the literal `event`. 404 for a slot the award
does not have.

- **Judged award** — roles: admin, judge. Body `{team_id}`. Replaces the
  slot's row. `DELETE` clears it.
- **Performance award** — role: admin. Body `{team_ids, reason}`; `team_ids`
  is non-empty with no duplicates, `reason` is non-empty. Stores `override`
  rows. `DELETE` removes the override; the slot goes back to its resolver.
  A judge gets 403.

Each team must be in the slot's division (any division for an event slot)
and must have a participation row for the session; otherwise 422.

### 6.3 Team history

`GET /sessions/{session_id}/awards/team-history` — roles: any. For each
team, its winners in this session and in earlier sessions of the season
(earlier by the same session order skills rankings use), each with award
name, kind, session id and label. Includes stored winners and, for this
session only, currently resolved performance winners. The judged picker
uses it for its warnings.

### 6.4 Finalize (admin only)

- `POST /sessions/{session_id}/awards/finalize` — body `{confirm: bool}`.
  Without `confirm` (or false): returns `{warnings: [...]}` listing every
  `judged_pending`, `no_result`, and `provisional` slot, and changes
  nothing. With `confirm: true`: for every performance slot with no stored
  rows, writes its resolved teams as `finalized` rows (nothing for a
  `no_result` slot), sets `awards_finalized_at`, and returns the same
  warnings.
- `POST /sessions/{session_id}/awards/unfinalize` — deletes `finalized`
  rows, keeps `judged` and `override` rows, clears `awards_finalized_at`.
  409 if not finalized.

### 6.5 Export and realtime

- `GET /sessions/{session_id}/awards.csv` — roles: any. One row per winner
  (one row with empty team columns for a slot with none), in award order,
  then slot order. Columns: `award`, `description`, `division`,
  `placement`, `team_number`, `team_name`, `organization`, `status`.
- WebSocket: `awards_changed` with `{session_id}`, sent with
  `broadcast_for_session` after every award write.

## 7. Admin UI

### 7.1 Admin: the session Awards tab

New route `sessions/:sessionId/awards` (`SessionAwardsRoute`), a tab in the
session layout after Rankings.

- **Toolbar:** Add award, Copy awards from… (session picker), Export CSV,
  Finalize awards / Unfinalize.
- **Award cards** in ceremony order, with up/down buttons to reorder. Each
  shows name, description, and a rule summary ("Performance · Finals
  placement 1 · per division", "Judged · event-wide"), with Edit and Delete.
- **Slot rows** under each card: division (or "Event"), winners, a status
  badge (Pending, Judged, Live, Provisional, No result yet, Overridden,
  Finalized), any note or warning, and actions: for judged, Choose winner /
  Clear; for performance, Override / Remove override.
- **Award form** (dialog): name, description, kind, scope (event, or
  divisions as checkboxes, all checked meaning every division), and for
  performance: source (teamwork ranking, finals, skills overall, one option
  per skills type from the game plugin), basis (session, season so far),
  placement. Combinations the rules forbid are not offered (event scope
  hides teamwork ranking and finals; finals fixes basis to session). Editing
  a rule field on an award with stored winners asks for confirmation first.
- **Judged winner picker** (dialog): a searchable list of teams entered in
  the session and in the slot's division. Each team shows its awards from
  team history. A warning badge reads "Already won a judged award this
  session" or "Already won a judged award this season". Choosing such a
  team is allowed.
- **Override dialog:** choose one or more teams (same list), required
  reason.
- **Finalize:** a confirm dialog lists the warnings from the dry run. Once
  finalized, a banner shows the time and every edit control is disabled
  except Unfinalize.

### 7.2 Judge role

Logging in as `judge` shows a judge navigation for the event's **active
session**: Awards, Session rankings, Season rankings. With no active
session, Awards and Session rankings show a "No active session" message.

- **Awards** is the same page in judge mode: only judged awards, with
  Choose winner and Clear; no toolbar, definition editing, override, or
  finalize. When finalized, the banner shows and the pickers are disabled.
- **Session rankings** and **Season rankings** are the existing pages,
  read-only (teamwork and skills tabs). The judge sees no other session
  tabs.

Route guards send a judge who opens any other route to Awards.

### 7.3 Live updates

The Awards page refetches on `awards_changed`, and on `score_saved`, finals
events, and `skills_changed`, because live winners are computed on read.

## 8. Edge cases

- **Deleting a team:** the deletion service also deletes its `AwardWinner`
  rows.
- **Deleting a division:** removed from every award's `division_ids` (an
  award left with an empty list then covers every division), and that
  division's `AwardWinner` rows are deleted.
- **Deleting or recreating a finals bracket:** finals awards resolve to no
  result; stored overrides and finalized rows stay.
- **Deleting a session:** cascades to its awards and winners.
- **A team moved to another division after winning:** stored rows keep it;
  the slot shows a warning (section 6.1).
- **Placement beyond the number of ranked teams:** no result.

## 9. Testing

pytest, against a real app and a temp-file SQLite database:

- **Migration:** upgrade creates the tables and column; downgrade removes
  them.
- **Resolvers:** teamwork ranking, session and season basis; skills overall
  and per type, event-wide and per division with renumbering, and a tie
  giving both teams the award; score chase complete and provisional;
  single elimination 1st and 2nd, 3rd and 4th by seed, quarterfinal losers,
  an undecided placement; every no-result case (no rankings, no bracket,
  placement too high, unknown skills type, skills disabled).
- **Definitions API:** create, edit, delete with position closing, order,
  copy; every validation rule in 3.1; a rule-field edit deleting winners and
  a name edit keeping them.
- **Winners API:** judged set and clear; override set and remove; team not
  in division or not in session gives 422; unknown slot gives 404.
- **Roles:** admin does everything; judge writes judged slots only and gets
  403 on definitions, overrides, and finalize; scorer and referee read only.
- **Team history:** this session and earlier sessions, including resolved
  winners for this session.
- **Finalize:** dry run lists warnings and writes nothing; confirm writes
  `finalized` rows; every write returns 409 while finalized; a score change
  after finalizing does not change winners; unfinalize keeps judged and
  override rows.
- **CSV:** exact columns and order, including an empty slot.
- **Realtime:** `awards_changed` after a write.
- **Edge cases** in section 8.

Frontend:

- **Vitest:** the form's field rules, the status badges, the picker's
  warnings, judge mode showing judged awards only.
- **Playwright:** admin golden path (define awards against seeded results,
  see live winners, choose a judged winner, override, finalize, see the
  edit lock, unfinalize); copy awards from another session; CSV download;
  judge login sees only Awards and the two rankings pages, chooses a
  judged winner, and sees no performance controls.

## 10. Docs and follow-ups

- `server/CLAUDE.md`: awards models, sources registry, API, roles, and the
  finalize rule.
- `frontend/CLAUDE.md`: the Awards tab and the judge navigation.
- Master architecture spec: an "As built" note on the `Award` model.
- Future specs: award plugins, a judges app, reveal mode on the audience
  display, a season awards report, Tournament Finals.
