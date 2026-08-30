# Qualification & Practice Scheduling — Design Spec

Status: approved for planning
Date: 2026-08-29

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

This spec covers **Phase 4**: generating a session's practice and
qualification match schedule via a pluggable schedule-generator, following
the core server and plugin architecture from
`2026-08-28-core-server-plugin-architecture-design.md` (the "master spec")
and building on Match & Scoring (Phase 3).

In scope:
- `Field` and `FieldSet` data model, session-scoped.
- Generalizing the existing game-plugin registry (`plugin_registry/`) into a
  kind-parameterized registry shared by game and scheduler plugins.
- The schedule-generator plugin contract (master spec §5.2), with two
  built-in generators (`simple_random`, `balanced`) shipped as installed
  plugins, not core code.
- `POST /api/schedule` (generate) and `DELETE /api/schedule` (clear) as a
  first-class resource distinct from ad hoc single-match creation.
- `ScheduleGeneration` — a record of each generation action, per the master
  spec §3's requirement that "each schedule-generation action ... records
  which scheduler plugin (name, version) it used."

Explicitly out of scope / deferred (see §7):
- Elimination brackets — a separate phase. No plugin contract for bracket
  progression exists yet; it depends on live match results rather than
  being generated once, which is a materially different problem from
  up-front schedule generation.
- Smart schedule regeneration that preserves already-played matches when
  the roster changes mid-session.
- Explicit pairing avoid-lists beyond automatic same-organization and
  repeat-pairing avoidance (`balanced`'s existing job).
- Any UI. This spec defines the REST surface only.

## 2. Data model

Two new models, both session-scoped:

- **`FieldSet`** — `id, session_id (FK), name`. A named pool of fields.
  Multiple FieldSets in a session run **concurrently**; fields within one
  FieldSet process matches **sequentially** from a queue (one match active
  at a time per set — multiple fields in a set exist for physical
  changeover speed, not true simultaneity).
- **`Field`** — `id, field_set_id (FK, not null), name`. Every field
  belongs to exactly one FieldSet. Creating a session's first field with no
  `field_set_id` given auto-creates a default FieldSet (e.g. `"Main
  Fields"`) so a small single-field-set event needs no explicit FieldSet
  setup. `Field` has no `session_id` column of its own — session is
  reached via `field.field_set.session_id`, avoiding denormalization.

Changes to the existing `Match` model (Phase 3):
- `field_id` changes from a plain string to a real FK on `Field.id`
  (nullable — a match can exist unassigned). Manual match creation via
  `POST /api/matches` gets the same validate-or-404 treatment `division_id`
  received in Phase 3's final review, for consistency.
- New `time_slot: int` (nullable) column, scoped the same way as
  `match_number` (unique per `session, division, round_type`): the
  synchronized round index a match belongs to within one generation
  action. This is what makes the concurrency-safety invariant (below)
  checkable — every FieldSet running concurrently gets at most one match
  per `time_slot`, and no team may appear in two matches sharing a
  `time_slot`.
- New `schedule_generation_id` (FK, nullable) — set for matches created by
  `POST /api/schedule`; null for manually-created matches.

New model:

- **`ScheduleGeneration`** — `id, session_id (FK), division_id (FK,
  nullable), round_type, scheduler_plugin_name, scheduler_plugin_version,
  target_matches_per_team, generated_at`. One row per successful
  `POST /api/schedule` call.

This is a schema change to the existing `matches` table (type/semantics
change on `field_id`, two new columns) on top of Phase 3's own schema
change to `events` — same situation: no real deployed event data exists
yet, so a pre-Phase-4 database is recreated (delete the `.db` file), not
migrated.

## 3. Plugin registry generalization

The existing `plugin_registry` package (`loader.py`, `discovery.py`,
`zip_install.py`, `conformance.py`) is hardcoded to game plugins:
`kind != "game"` checks, a hardcoded `"games"` folder name, a
`LoadedGamePlugin` type. This phase generalizes it to support both game and
scheduler plugins through one shared code path, rather than duplicating the
package or abandoning the plugin mechanism for schedulers:

- A `PluginKind` descriptor (`kind: str`, `folder_name: str`,
  `required_functions: tuple[str, ...]`) parameterizes what was hardcoded.
- `LoadedGamePlugin` becomes a generic `LoadedPlugin(kind, name, version,
  module, path)` — the distinction lives in which registry/folder a plugin
  came from, not in its Python type.
- `app.state` holds two independent registries, `game_plugins` and
  `scheduler_plugins`, each populated by the same `discover_plugins(
  plugins_root, kind)` pointed at a different `PluginKind`.
- `manifest.py` and `zip_install.py`'s manifest/structural parsing is
  already kind-agnostic (confirmed by reading the current code) and needs
  no changes beyond removing the hardcoded `"game"`/`"games"` checks.
- `conformance.py` keeps shared manifest/structural checks and branches
  only on kind-specific deep checks: schema-shape checks for game plugins
  (unchanged); a new, much simpler check for scheduler plugins (callable,
  returns a well-formed match list for representative sample input).
  `tm test-plugin` auto-detects kind from the manifest and runs the
  matching check set.

This is a refactor of existing, tested code. The full existing Phase 2
plugin test suite (discovery, zip-install, conformance) must still pass
unchanged — that suite is the regression net proving the generalization
didn't change game-plugin behavior.

## 4. Schedule-generator plugin contract

One required module-level function, per the master spec §5.2:

```
generate_schedule(
    teams, target_matches_per_team, fields, field_sets,
    cross_session_pairing_history, constraints
) -> matches
```

Shapes:

- `teams`: `[{"team_id": int, "organization": str | None}, ...]`.
  `organization` lets `balanced` avoid same-organization pairings.
- `target_matches_per_team`: `int`, admin-specified per generation request.
- `field_sets`: `[{"field_set_id": int, "name": str}, ...]`.
- `fields`: `[{"field_id": int, "field_set_id": int}, ...]` — tells the
  plugin each set's field *count* (its sequential-queue capacity), not a
  specific field assignment.
- `cross_session_pairing_history`: `dict[frozenset[int], {"partner_count":
  int, "opponent_count": int}]`, aggregated across **every session in the
  event**, not just the one being scheduled. Native Python dict with
  `frozenset` keys — plugins are in-process function calls, not HTTP, so
  this isn't JSON-constrained the way scoresheet data is.
- `constraints`: `{"excluded_team_ids": [int, ...]}` — Phase 4's minimal
  scope. A team present in `SessionParticipation` but not ready for this
  particular generation run can be excluded without removing it from the
  session.
- Returns `matches`: `[{"time_slot": int, "field_set_id": int,
  "alliances": [{"station": "red", "team_ids": [...]}, {"station": "blue",
  "team_ids": [...]}]}, ...]`.

**Division of responsibility** (mirrors Phase 3's "core computes
bookkeeping, plugin does domain logic" split): the plugin decides who plays
whom, on which alliance, in which `field_set_id`, in which `time_slot` —
satisfying the no-team-double-booked-per-`time_slot` invariant across field
sets. The **core server** assigns `match_number` (sequential, in the order
returned) and the literal `field_id` within each match's field_set (simple
round-robin across that set's fields, ordered by `time_slot`) — physical
field choice within one set is a logistics/changeover concern, not
scheduling logic, since only one match runs at a time within a single
field set.

Built-in generators, shipped as installed plugins under
`plugins/schedulers/<name>/` (not core code), discovered the same way as
game plugins per §3:
- `simple_random` — random assignment respecting field-set count and
  `target_matches_per_team`, no variety optimization.
- `balanced` — avoids repeat partner/opponent pairings and same-
  organization pairings where possible, using `cross_session_pairing_
  history`. Falls back to minimizing the maximum repeat count once every
  unique pairing within the current field/match-count constraints is
  exhausted.

Custom generators can be dropped in following the same interface, per the
master spec.

## 5. Endpoints

Field/FieldSet CRUD (session-scoped, mirroring existing resource patterns):

- `POST /api/field-sets` — `{session_id, name}`.
- `GET /api/field-sets?session_id=`.
- `POST /api/fields` — `{session_id, name, field_set_id: int | None}`.
  Omitting `field_set_id`: auto-resolves to the session's one existing
  FieldSet, or creates a default `"Main Fields"` one if the session has
  none yet. If the session already has more than one FieldSet, omitting it
  is a 422 (ambiguous which set the field belongs to).
- `GET /api/fields?session_id=`.

Schedule generation, as its own resource distinct from raw Match CRUD:

- `POST /api/schedule` — `{session_id, division_id, round_type,
  target_matches_per_team, scheduler_plugin_name, excluded_team_ids}`.
  Validates session/division/round_type/plugin exist, 409s if any Match
  already exists for that `(session_id, division_id, round_type)` (Phase
  4's "reject outright" — see §7), builds `teams` and
  `cross_session_pairing_history` by querying the whole event's match
  history, calls the plugin, and **validates the returned schedule
  structurally before persisting anything**: no team repeated in a
  `time_slot`, alliances well-formed (exactly 2, valid stations, non-empty
  team lists), `field_set_id`s reference real FieldSets for this session.
  This is the same validate-before-persist discipline as Phase 3's scoring
  fix, applied here because a scheduler plugin is equally capable of
  returning garbage. On success: creates one `ScheduleGeneration` row, then
  the Match/Alliance/AllianceTeam rows, each Match FK'd to that
  `ScheduleGeneration`.
- `DELETE /api/schedule` — query params `session_id, division_id,
  round_type`. Deletes every Match (cascading to Alliance/AllianceTeam/
  ScoreRecord) for that combination. This also deletes the `Ranking` rows
  for that `(session_id, division_id)` — Phase 3's final review deferred
  stale-`Ranking`-row cleanup generally as needing real design work, but
  this new clear action makes that gap immediately visible in practice
  (delete all qualification matches, old rankings for that division would
  otherwise keep showing). Deleting the `Ranking` rows here is a narrow fix
  scoped to this one new action, not the general redesign, which stays
  deferred.

## 6. Testing

- The full existing Phase 2 plugin test suite must still pass unchanged
  after the registry generalization (§3) — proves no behavior regression.
- A fixture scheduler plugin (mirroring `example-game`) for scheduler
  discovery/zip-install/conformance tests.
- Field/FieldSet CRUD tests, including the auto-default-FieldSet behavior
  and the more-than-one-FieldSet-exists 422 case.
- `POST /api/schedule` tests: happy path; 409 on existing matches for the
  same combination; structural validation rejecting a plugin that returns
  a double-booked `time_slot` or a malformed alliance.
- `DELETE /api/schedule` tests: matches and their Alliances/ScoreRecords
  are gone; `Ranking` rows for that division are gone.
- A cross-session pairing-history test: a multi-session event, verifying
  partner/opponent counts aggregate correctly across sessions, not just
  the session being scheduled.

## 7. Deferred / open items

- **Elimination brackets** — a separate phase. `EliminationBracket` (master
  spec §3: `division_id, round, wins_to_advance, seed_overrides[],
  unavailable_teams[]`) is a stateful bracket that progresses as matches
  complete, with no plugin contract defined for it yet — a materially
  different problem from up-front schedule generation.
- **Smart schedule regeneration preserving already-played matches** — the
  reference tool's current behavior (and this phase's Phase-4 behavior) is
  destructive: any schedule change requires deleting everything for that
  round_type/division and starting over, even matches already played. A
  real improvement would let an organizer add a late-arriving or
  previously-mis-checked-in team and regenerate only the not-yet-played
  portion of the schedule, keeping completed matches and their scores
  intact. This needs real design work (which matches count as "already
  played" and immovable, how pairing-history accounting treats a partial
  regeneration) and is deliberately not built now — `DELETE`-then-
  `POST /api/schedule` (§5) is the "good first position," per an explicit
  product decision to accept the same pain point as the reference tool for
  this phase rather than rush a partial fix.
- **Explicit pairing avoid-lists** beyond automatic same-organization/
  repeat-pairing avoidance — deferred; `excluded_team_ids` (§4) covers
  Phase 4's actual need (skip a not-ready team for one generation run).
