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

A game plugin is a folder — `plugins/games/<name>/` — containing
`manifest.json` (`name`, `version`, `kind: "game"`, `display_name`) and
`plugin.py`, which must define seven module-level functions:
`match_format`, `scoresheet_schema`, `calculate_score`, `validate`,
`rank_teams`, `skills_scoresheet_schema`, `calculate_skills_score`. See
`tournament_server/plugin_registry/loader.py`'s
`REQUIRED_GAME_PLUGIN_FUNCTIONS` for the authoritative list, and
`tests/fixtures/plugins/games/example-game/plugin.py` for a complete
working example.

The server scans `<plugins_root>/games/*/` at startup
(`plugin_registry/discovery.py`) and also accepts new plugins at
runtime via `POST /api/plugins/games` (a zip with `manifest.json` and
`plugin.py` at its root — no wrapping folder). A newly installed plugin
is registered immediately; no restart is needed. Startup discovery
skips a broken plugin folder with a warning rather than crashing; a zip
upload that fails to install is rejected outright with a 409 (name
already taken) or 422 (malformed).

Before distributing a plugin, its author should run
`tm test-plugin <path-to-plugin-folder>`, which checks the plugin's
contract (required functions present, schema shapes valid, scoring
functions deterministic and int-returning, `rank_teams` produces a
clean 1..N ranking) and exits non-zero on any failure. This conformance
tool does not yet check for anything beyond the contract itself
(no checksums, no capability scanning — that hardening is a separate,
later phase per the design spec's §9).

## Known, deliberate gaps in this phase

- There's no real authentication yet. Requests can pass an
  `X-Actor-Name` header to identify who's making a change (used only for
  the audit log); it defaults to `"admin"`. Don't mistake this for a
  security boundary — anyone can claim to be anyone. A real
  identity/admission system is a later phase (Device/ScoringDevice
  admission is designed in the spec but not implemented in this plan).
- A Team belongs to at most one Division (nullable `division_id`), not a
  many-to-many relationship, as a deliberate YAGNI simplification — see
  the plan's Global Constraints for why.
- No Alembic/migrations yet — schema changes go through
  `Base.metadata.create_all()`, which only adds new tables, never alters
  existing ones. Introduce real migrations before the schema needs to
  change on a database that already has real event data in it.

## Testing

Every test in `tests/` uses the `client` fixture from `conftest.py`,
which builds a fresh `FastAPI` app against a fresh temp-file SQLite
database per test — never a shared or mocked database. Follow that
pattern for new tests: real HTTP calls through `TestClient`, a real
(temporary) SQLite file underneath.
