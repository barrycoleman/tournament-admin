# Server-specific instructions

This is the core tournament server: FastAPI + SQLAlchemy 2.0 + SQLite,
one process and one database file per event. The full architecture is in
`../docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`;
the root `../CLAUDE.md` has the project-wide constraints (no brand names,
mandatory testing policy) that apply here too.

## Local development

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
python -m tournament_server.main   # runs the dev server on 127.0.0.1:8000
```

## Layout

- `models/` — one SQLAlchemy model per file, one table each.
- `schemas/` — Pydantic request/response schemas, one file per resource,
  matching the `models/` file it serves.
- `routers/` — one FastAPI `APIRouter` per resource.
- `audit.py` — the only place that knows how audit logging works. It
  hooks in generically via SQLAlchemy mapper events
  (`after_insert`/`after_update`/`after_delete` on `Base`, with
  `propagate=True`), so a new model defined anywhere automatically gets
  audited — nothing needs to call into `audit.py` by hand.
- `db.py` — the SQLAlchemy `Base`, engine/session-factory helpers, and
  `init_db()`. Every model module does `from tournament_server.db import Base`.

## Plugin system

A plugin is a folder — `plugins/<games-or-schedulers>/<name>/` —
containing `manifest.json` (`name`, `version`, `kind`, `display_name`) and
`plugin.py`. Two plugin kinds exist, sharing one generic registry
(`plugin_registry/loader.py`'s `PluginKind`, `load_plugin`,
`discover_plugins`): a **game** plugin (`kind: "game"`, folder
`plugins/games/<name>/`) must define seven module-level functions —
`match_format`, `scoresheet_schema`, `calculate_score`, `validate`,
`rank_teams`, `skills_scoresheet_schema`, `calculate_skills_score` (see
`GAME_PLUGIN_KIND` for the authoritative list, and
`tests/fixtures/plugins/games/example-game/plugin.py` for a complete
working example); a **scheduler** plugin (`kind: "scheduler"`, folder
`plugins/schedulers/<name>/`) must define one — `generate_schedule` (see
`SCHEDULER_PLUGIN_KIND`, and `plugins/schedulers/simple_random/plugin.py`
for a complete working example).

The server scans both `<plugins_root>/games/*/` and
`<plugins_root>/schedulers/*/` at startup (`plugin_registry/discovery.py`)
and also accepts new plugins of either kind at runtime — `POST
/api/plugins/games` and `POST /api/plugins/schedulers` (each takes a zip
with `manifest.json` and `plugin.py` at its root — no wrapping folder). A
newly installed plugin is registered immediately; no restart is needed.
Startup discovery skips a broken plugin folder with a warning rather than
crashing; a zip upload that fails to install is rejected outright with a
409 (name already taken) or 422 (malformed).

Before distributing a plugin, its author should run
`tm test-plugin <path-to-plugin-folder>`, which checks the plugin's
contract and exits non-zero on any failure. It works for either plugin
kind, auto-detected from the plugin's manifest `kind` field: a game
plugin is checked for required functions present, schema shapes valid,
scoring functions deterministic and int-returning, and `rank_teams`
producing a clean 1..N ranking; a scheduler plugin is checked against the
`SCHEDULER_PLUGIN_KIND` contract (`generate_schedule` present and
returning a valid schedule shape). This conformance tool does not yet
check for anything beyond the contract itself (no checksums, no
capability scanning — that hardening is a separate, later phase per the
design spec's §9).

The plugin folder root is configurable via the `TOURNAMENT_PLUGINS_ROOT`
environment variable (default `./plugins`, resolved relative to wherever
the process was launched — a known packaging-phase gap, see the design
spec's §10). The registry holds at most one active version per plugin
`name`; installing a zip whose `name` is already installed is rejected
(409), and there is currently no uninstall/replace endpoint — swapping
or removing an installed plugin is a manual filesystem operation on the
plugins directory today.

Every key in a `scoresheet_schema()`/`skills_scoresheet_schema()` field
dict must be *present*, even when its value is `None` — e.g. a
non-enum field still needs `"options": None`, not an omitted `options`
key. This is what the conformance tool and the loader both check for;
see `tests/fixtures/plugins/games/example-game/plugin.py` for the
pattern every field in that fixture follows.

## Match & scoring

An Event selects exactly one game plugin via `POST /api/event/game-plugin`
— immutable once set. A Match always has exactly two Alliances (created
together via `POST /api/matches`), each holding one or more Teams through
the `alliance_teams` join table. `POST /api/matches/{id}/alliances/{id}/score`
runs the event's plugin's `validate()` (blocking on violations unless
`force: true` is passed) and stores the raw scoresheet as JSON — an
alliance's actual score is always *derived* via `calculate_score()`, never
stored redundantly, so it can never go stale relative to the plugin's
logic. A Match becomes `"completed"` once every Alliance has a saved
`ScoreRecord`, which triggers a ranking recompute for its session/division.

Win-point allocation (2/1/0 for win/tie/loss) and strength-of-schedule
(sum of opponents' current win points) are computed by the core server,
not the plugin — see `services/ranking.py`. The plugin's `rank_teams()`
only receives those pre-computed numbers plus each team's
`tiebreaker_seed` and handles the final sort/tiebreak. This is narrower
than the design spec's §5.1 prose ("win-point allocation" as something
`rank_teams` does), but matches the plugin interface actually built and
tested in Phase 2 — see that phase's plan for the reasoning.

Every list/read endpoint that's scoped to a session (`GET /api/matches`,
`GET /api/rankings`) takes an explicit `session_id` query parameter,
defaulting to `Event.active_session_id` via the shared
`deps.get_session_id` dependency when omitted.

No-show/DQ handling: an alliance's effective score is `0` wherever it
matters (the score-submission response, ranking computation) when its
`ScoreRecord.no_show` or `.dq` is set — this zeroing is core-server logic,
never passed into the plugin's `calculate_score()`.

## Scheduling

Every Field belongs to exactly one FieldSet (`field_set_id` is required,
never nullable). FieldSets in the same session run concurrently; fields
within one FieldSet process matches sequentially — only one match is ever
active per FieldSet at a time. `POST /api/fields` auto-creates a default
`"Main Fields"` FieldSet when a session has none yet, and requires an
explicit `field_set_id` once a session has more than one (ambiguous
otherwise).

`POST /api/schedule` generates a full practice/qualification schedule for
one `(session_id, division_id, round_type)` combination in a single call,
via a scheduler plugin's `generate_schedule()`. It 409s if matches already
exist for that combination — regenerating requires an explicit
`DELETE /api/schedule` first, which deletes only that combination's
Matches (and their Alliances/AllianceTeams/ScoreRecords) and then
recomputes that division's `Ranking` rows from whatever completed matches
remain — including ones from other, untouched `round_type`s — rather than
leaving them either stale or wiped (a scoped fix for the general
stale-ranking-row cleanup gap noted under Match & scoring above — this
action makes that gap immediately visible, so it's addressed here
specifically). The scheduler plugin
decides who plays whom and which FieldSet/time_slot each match runs in; the
core server assigns `match_number` and the literal `field_id` afterward
(round-robin within each match's FieldSet) — see `services/scheduling.py`
for the cross-session pairing-history query the plugin receives, and
`routers/schedule.py`'s `_validate_generated_schedule` for the structural
checks (correct alliance shape, no team double-booked within a
`time_slot`) applied to whatever the plugin returns, before anything is
persisted — the same validate-before-persist discipline used for score
submission.

Two scheduler plugins ship in this repo, at `plugins/schedulers/`:
`simple_random` (random, no optimization) and `balanced` (avoids repeat
partner/opponent pairings and same-organization pairings using pairing
history from every session in the event, falling back to minimizing the
worst repeat count once every unique pairing is exhausted). Both are real
plugins, not core code — a custom generator can replace either by
following the same `generate_schedule` contract.

Elimination brackets are a separate, later phase — no plugin contract for
bracket progression exists yet.

## Known, deliberate gaps in this phase

- There's no real authentication yet. Requests can pass an
  `X-Actor-Name` header to identify who's making a change (used only for
  the audit log); it defaults to `"admin"`. Don't mistake this for a
  security boundary — anyone can claim to be anyone. A real
  identity/admission system is a later phase (Device/ScoringDevice
  admission is designed in the spec but not implemented in this plan).
- The plugin-install endpoints (`POST /api/plugins/games` and
  `POST /api/plugins/schedulers`) dynamically import and execute arbitrary
  uploaded Python code, with the same "no real authentication" gap as
  everything above — but this is qualitatively more dangerous than a CRUD
  endpoint, since it's a code-execution primitive, and that risk applies
  identically to both endpoints (there's nothing game-plugin-specific
  about it). This was raised explicitly with the project owner, who
  accepted the risk for now (local-LAN, single-admin-in-the-room threat
  model) rather than bolt on a one-off check ahead of a real auth system.
  See the design spec's §10 for the role-based-passwords + JWT direction
  planned for that future phase.
- A Team belongs to at most one Division (nullable `division_id`), not a
  many-to-many relationship, as a deliberate YAGNI simplification — see
  the plan's Global Constraints for why.
- No Alembic/migrations yet — schema changes go through
  `Base.metadata.create_all()`, which only adds new tables, never alters
  existing ones. **This line has already been crossed** twice: Phase 3
  added `Event.game_plugin_name` to the pre-existing `events` table, and
  this scheduling phase changed the `matches` table three more ways —
  `field_id` went from a plain string to an integer FK, and two new
  columns (`time_slot`, `schedule_generation_id`) were added. A database
  created before either of these changes will fail with a `no such
  column` (or a type-mismatch) error on first read. No real events have
  been created against this schema yet, so recreating the database is
  the correct fix today — delete the `.db` file and let `create_all()`
  build it fresh. Introduce real migrations before this project has any
  real deployed event data that can't simply be recreated.
- Scheduling two Divisions within the same Session currently produces a
  broken schedule. Each `POST /api/schedule` call is self-contained — it
  restarts `time_slot` numbering at 0 and round-robins fields starting
  from the session's lowest field id, with no way to scope a generation
  to a subset of the session's FieldSets. Two divisions scheduled in the
  same session will collide on both fields and time_slots, even though
  FieldSets running concurrently is exactly the scenario `time_slot`
  exists to keep safe within one generation call. A real fix needs a way
  to scope a `POST /api/schedule` call to specific FieldSets (or
  session-wide slot/field arbitration across all divisions), which is
  real design work, not a bounded bugfix — deferred to a later phase. For
  now, an event with multiple divisions that need concurrent physical
  fields in the same session should not use this endpoint for more than
  one division per session until that's built.

## Testing

Most tests use the `client` fixture from `conftest.py`, which builds a
fresh `FastAPI` app against a fresh temp-file SQLite database (and an
isolated temp `plugins_root`) per test — never a shared or mocked
database. The fixture also pre-seeds the `example-game` game plugin and the
`simple_random`/`balanced` scheduler plugins into that `plugins_root`
before the app starts, so all three are discoverable at startup like real
installed plugins — tests that need a *different* starting registry state
(e.g. an empty one, or one containing a specific other plugin) should
build their own `create_app()`/`TestClient` instance directly rather than
relying on `client`, the way `test_list_game_plugins_discovers_at_startup`
in `test_plugins_router.py` already does. Follow the `client` pattern for
anything else exercising the HTTP API: real calls through `TestClient`,
real temporary files underneath.

The `plugin_registry` subpackage also has plain unit tests (e.g.
`test_plugin_manifest.py`, `test_plugin_loader.py`,
`test_plugin_conformance.py`) that call its functions directly against
fixture plugin folders in `tests/fixtures/plugins/games/`, with no
`client`/`TestClient` involved — appropriate for logic that doesn't
touch the HTTP layer at all.
